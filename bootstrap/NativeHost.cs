using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

internal static class Program
{
    private const string GoogleCredentialTarget = "ESB.GeminiBroker.CodeAssist04";
    private const string PocCredentialTarget = "ESB.GeminiBroker.Poc.O1234567";
    private const int MaximumMessageBytes = 65536;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeCredential
    {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "CredReadW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr credential);

    private static int Main()
    {
        try
        {
            using (Stream input = Console.OpenStandardInput())
            using (Stream output = Console.OpenStandardOutput())
            {
                byte[] lengthBytes = ReadExactly(input, 4);
                int length = BitConverter.ToInt32(lengthBytes, 0);
                if (length <= 0 || length > MaximumMessageBytes)
                {
                    throw new InvalidOperationException("Invalid native message length.");
                }

                byte[] messageBytes = ReadExactly(input, length);
                string message = Encoding.UTF8.GetString(messageBytes);
                Array.Clear(messageBytes, 0, messageBytes.Length);

                JavaScriptSerializer serializer = new JavaScriptSerializer();
                Dictionary<string, object> request = serializer.Deserialize<Dictionary<string, object>>(message);
                object actionValue;
                object requestIdValue;
                string action = request != null && request.TryGetValue("action", out actionValue) ? actionValue as string : null;
                string requestId = request != null && request.TryGetValue("requestId", out requestIdValue) ? requestIdValue as string : null;
                Guid parsedRequestId;
                if (!Guid.TryParse(requestId, out parsedRequestId))
                {
                    throw new InvalidOperationException("Invalid native message request.");
                }

                string credentialTarget;
                string identityField;
                if (String.Equals(action, "getGoogleCredential", StringComparison.Ordinal))
                {
                    credentialTarget = GoogleCredentialTarget;
                    identityField = "email";
                }
                else if (String.Equals(action, "getPocCredential", StringComparison.Ordinal))
                {
                    credentialTarget = PocCredentialTarget;
                    identityField = "username";
                }
                else
                {
                    throw new InvalidOperationException("Invalid native message request.");
                }

                string[] credential = ReadCredential(credentialTarget);
                Dictionary<string, object> responsePayload = new Dictionary<string, object>
                {
                    { "ok", true },
                    { "password", credential[1] }
                };
                responsePayload.Add(identityField, credential[0]);
                string response = serializer.Serialize(responsePayload);
                WriteMessage(output, response);
                credential[0] = null;
                credential[1] = null;
                return 0;
            }
        }
        catch (Exception error)
        {
            try
            {
                using (Stream output = Console.OpenStandardOutput())
                {
                    JavaScriptSerializer serializer = new JavaScriptSerializer();
                    string response = serializer.Serialize(new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", PublicError(error) }
                    });
                    WriteMessage(output, response);
                }
            }
            catch
            {
                // Native host must never write diagnostics or credentials to stdout/stderr.
            }
            return 2;
        }
    }

    private static string[] ReadCredential(string target)
    {
        IntPtr pointer;
        if (!CredRead(target, 1, 0, out pointer))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Credential target was not found.");
        }
        try
        {
            NativeCredential credential = (NativeCredential)Marshal.PtrToStructure(pointer, typeof(NativeCredential));
            string username = Marshal.PtrToStringUni(credential.UserName) ?? String.Empty;
            string password = credential.CredentialBlobSize == 0
                ? String.Empty
                : Marshal.PtrToStringUni(credential.CredentialBlob, checked((int)credential.CredentialBlobSize) / 2) ?? String.Empty;
            if (String.IsNullOrWhiteSpace(username) || String.IsNullOrEmpty(password))
            {
                throw new InvalidOperationException("Credential target is incomplete.");
            }
            return new[] { username, password };
        }
        finally
        {
            CredFree(pointer);
        }
    }

    private static byte[] ReadExactly(Stream stream, int length)
    {
        byte[] buffer = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            int read = stream.Read(buffer, offset, length - offset);
            if (read == 0)
            {
                throw new EndOfStreamException("Native message ended early.");
            }
            offset += read;
        }
        return buffer;
    }

    private static void WriteMessage(Stream output, string json)
    {
        byte[] payload = Encoding.UTF8.GetBytes(json);
        byte[] length = BitConverter.GetBytes(payload.Length);
        output.Write(length, 0, length.Length);
        output.Write(payload, 0, payload.Length);
        output.Flush();
        Array.Clear(payload, 0, payload.Length);
    }

    private static string PublicError(Exception error)
    {
        if (error is Win32Exception)
        {
            return "Windows Credential Manager target is unavailable.";
        }
        return "Credential bridge request failed.";
    }
}

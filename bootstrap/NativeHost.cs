using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

internal static class Program
{
    private const string GoogleCredentialTarget = "ESB.GeminiBroker.CodeAssist04";
    private const string PocCredentialTarget = "ESB.GeminiBroker.Poc.O1234567";
    private const string ExpectedCallerOrigin = "chrome-extension://jeenmgigpkffleijbmfciffiodlcdafh/";
    private const string FirebaseApiKey = "AIzaSyBAmRwEIELh_AA7E1omzf8TrVV3Cp4HPFc";
    private const string PocAuthEmail = "o1234567@poc.invalid";
    private const string PocUsername = "O1234567";
    private const string PocFirebaseUid = "VHX1QkrsewSrrWB0g3BjyHepdWX2";
    private const int ProtocolVersion = 9;
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
            string[] commandLine = Environment.GetCommandLineArgs();
            if (commandLine.Length < 2
                || !String.Equals(commandLine[1], ExpectedCallerOrigin, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Invalid native caller.");
            }

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
                object versionValue;
                string action = request != null && request.TryGetValue("action", out actionValue) ? actionValue as string : null;
                string requestId = request != null && request.TryGetValue("requestId", out requestIdValue) ? requestIdValue as string : null;
                int version = request != null && request.TryGetValue("version", out versionValue)
                    ? Convert.ToInt32(versionValue)
                    : 0;
                Guid parsedRequestId;
                if (request == null
                    || request.Count != 3
                    || version != ProtocolVersion
                    || !Guid.TryParse(requestId, out parsedRequestId))
                {
                    throw new InvalidOperationException("Invalid native message request.");
                }

                Dictionary<string, object> responsePayload;
                if (String.Equals(action, "getGoogleCredential", StringComparison.Ordinal))
                {
                    Dictionary<string, object> authorization = AuthenticatePoc(serializer);
                    authorization["idToken"] = null;
                    string[] credential = ReadCredential(GoogleCredentialTarget);
                    responsePayload = new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "email", credential[0] },
                        { "password", credential[1] }
                    };
                    credential[0] = null;
                    credential[1] = null;
                }
                else if (String.Equals(action, "authenticatePoc", StringComparison.Ordinal))
                {
                    Dictionary<string, object> authorization = AuthenticatePoc(serializer);
                    responsePayload = new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "username", PocUsername },
                        { "idToken", authorization["idToken"] },
                        { "expiresIn", authorization["expiresIn"] }
                    };
                    authorization["idToken"] = null;
                }
                else
                {
                    throw new InvalidOperationException("Invalid native message request.");
                }

                string response = serializer.Serialize(responsePayload);
                WriteMessage(output, response);
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

    private static Dictionary<string, object> AuthenticatePoc(JavaScriptSerializer serializer)
    {
        string[] credential = ReadCredential(PocCredentialTarget);
        try
        {
            if (!String.Equals(credential[0], PocUsername, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("POC credential identity mismatch.");
            }

            string requestJson = serializer.Serialize(new Dictionary<string, object>
            {
                { "email", PocAuthEmail },
                { "password", credential[1] },
                { "returnSecureToken", true }
            });
            credential[1] = null;
            byte[] requestBytes = Encoding.UTF8.GetBytes(requestJson);
            requestJson = null;
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(
                    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + FirebaseApiKey);
                request.Method = "POST";
                request.ContentType = "application/json";
                request.ContentLength = requestBytes.Length;
                request.Timeout = 15000;
                request.ReadWriteTimeout = 15000;
                using (Stream requestStream = request.GetRequestStream())
                {
                    requestStream.Write(requestBytes, 0, requestBytes.Length);
                }

                string responseJson;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    responseJson = reader.ReadToEnd();
                }
                Dictionary<string, object> responsePayload =
                    serializer.Deserialize<Dictionary<string, object>>(responseJson);
                responseJson = null;
                object emailValue;
                object localIdValue;
                object idTokenValue;
                object expiresInValue;
                string email = responsePayload != null && responsePayload.TryGetValue("email", out emailValue)
                    ? emailValue as string
                    : null;
                string localId = responsePayload != null && responsePayload.TryGetValue("localId", out localIdValue)
                    ? localIdValue as string
                    : null;
                string idToken = responsePayload != null && responsePayload.TryGetValue("idToken", out idTokenValue)
                    ? idTokenValue as string
                    : null;
                object expiresIn = responsePayload != null && responsePayload.TryGetValue("expiresIn", out expiresInValue)
                    ? expiresInValue
                    : "3600";
                if (!String.Equals(email, PocAuthEmail, StringComparison.OrdinalIgnoreCase)
                    || !String.Equals(localId, PocFirebaseUid, StringComparison.Ordinal)
                    || String.IsNullOrWhiteSpace(idToken))
                {
                    throw new InvalidOperationException("Firebase POC identity mismatch.");
                }
                return new Dictionary<string, object>
                {
                    { "idToken", idToken },
                    { "expiresIn", expiresIn }
                };
            }
            finally
            {
                Array.Clear(requestBytes, 0, requestBytes.Length);
            }
        }
        finally
        {
            credential[0] = null;
            credential[1] = null;
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

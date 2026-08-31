using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace SsoGeminiLogin.Agent;

internal static class WindowsCredentialStore
{
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	private struct NativeCredential
	{
		public uint Flags;

		public uint Type;

		public nint TargetName;

		public nint Comment;

		public FILETIME LastWritten;

		public uint CredentialBlobSize;

		public nint CredentialBlob;

		public uint Persist;

		public uint AttributeCount;

		public nint Attributes;

		public nint TargetAlias;

		public nint UserName;
	}

	private const uint CredTypeGeneric = 1u;

	public static WindowsCredential Read(string target)
	{
		ArgumentException.ThrowIfNullOrWhiteSpace(target, nameof(target));
		if (!CredRead(target, 1u, 0u, out var credentialPointer))
		{
			throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows Credential Manager target '" + target + "' was not found.");
		}
		try
		{
			NativeCredential nativeCredential = Marshal.PtrToStructure<NativeCredential>(credentialPointer);
			string? obj = Marshal.PtrToStringUni(nativeCredential.UserName) ?? string.Empty;
			string text = ((nativeCredential.CredentialBlobSize == 0) ? string.Empty : (Marshal.PtrToStringUni(nativeCredential.CredentialBlob, checked((int)nativeCredential.CredentialBlobSize) / 2) ?? string.Empty));
			if (string.IsNullOrWhiteSpace(obj) || string.IsNullOrEmpty(text))
			{
				throw new InvalidOperationException("Windows Credential Manager target '" + target + "' is incomplete.");
			}
			return new WindowsCredential(obj, text);
		}
		finally
		{
			CredFree(credentialPointer);
		}
	}

	[DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "CredReadW", SetLastError = true)]
	[return: MarshalAs(UnmanagedType.Bool)]
	private static extern bool CredRead(string target, uint type, uint flags, out nint credentialPointer);

	[DllImport("advapi32.dll")]
	private static extern void CredFree(nint credentialPointer);
}

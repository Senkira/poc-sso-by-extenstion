using System;
using System.IO;
using System.Linq;

namespace SsoGeminiLogin.Agent;

internal sealed record AgentSettings(string CredentialTarget, string EdgeExecutable, string ProfileRoot, string? RealEvidenceDirectory, int MaxWorkers, bool Headless, TimeSpan IdleTimeout)
{
	public static AgentSettings Load()
	{
		string baseDirectory = AppContext.BaseDirectory;
		string? text = Environment.GetEnvironmentVariable("EDGE_EXECUTABLE");
		if (string.IsNullOrWhiteSpace(text))
		{
			text = ResolveInstalledEdge();
		}
		string? text2 = Environment.GetEnvironmentVariable("BROWSER_PROFILE_ROOT");
		if (string.IsNullOrWhiteSpace(text2))
		{
			text2 = Path.Combine(baseDirectory, "data", "profiles");
		}
		string? environmentVariable = Environment.GetEnvironmentVariable("POC_REAL_EVIDENCE_DIRECTORY");
		return new AgentSettings(Environment.GetEnvironmentVariable("POC_CREDENTIAL_TARGET") ?? "ESB.GeminiBroker.CodeAssist04", text, Path.GetFullPath(text2), string.IsNullOrWhiteSpace(environmentVariable) ? null : Path.GetFullPath(environmentVariable), ParsePositiveInt("MAX_BROWSER_WORKERS", 3), !string.Equals(Environment.GetEnvironmentVariable("BROWSER_HEADLESS"), "false", StringComparison.OrdinalIgnoreCase), TimeSpan.FromMilliseconds(ParsePositiveInt("BROWSER_IDLE_TIMEOUT_MS", 1200000)));
	}

	private static int ParsePositiveInt(string name, int fallback)
	{
		if (!int.TryParse(Environment.GetEnvironmentVariable(name), out var result) || result <= 0)
		{
			return fallback;
		}
		return result;
	}

	private static string ResolveInstalledEdge()
	{
		string[] array =
		[
			Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
			Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe")
		];
		return array.FirstOrDefault(File.Exists) ?? throw new FileNotFoundException("Microsoft Edge was not found.");
	}
}

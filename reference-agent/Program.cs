using System;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using SsoGeminiLogin.Agent;

internal static class Program
{
	private static async Task Main(string[] args)
	{
		JsonSerializerOptions serializerOptions = new JsonSerializerOptions
		{
			PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
			PropertyNameCaseInsensitive = true
		};
		try
		{
			AgentSettings agentSettings = AgentSettings.Load();
			WindowsCredential windowsCredential = WindowsCredentialStore.Read(agentSettings.CredentialTarget);
			string text = windowsCredential.Username.Trim().ToLowerInvariant();
			byte[] inArray = SHA256.HashData(Encoding.UTF8.GetBytes(text));
			AgentAccount account = new AgentAccount(Convert.ToHexString(inArray).Substring(0, 16).ToLowerInvariant(), text);
			await using BrowserWorkerPool pool = new BrowserWorkerPool(agentSettings, account, windowsCredential);
			Console.Error.WriteLine("Local Browser Agent account: " + account.Email);
			Console.Error.WriteLine("Google credentials and profile remain inside the Agent process.");
			while (true)
			{
				string? line = await Console.In.ReadLineAsync().ConfigureAwait(continueOnCapturedContext: false);
				if (line != null)
				{
					line = line.TrimStart('\ufeff');
					int num = line.IndexOf('{', StringComparison.Ordinal);
					if (num > 0)
					{
						line = line.Substring(num);
					}
					AgentResponse value;
					try
					{
						AgentRequest request = JsonSerializer.Deserialize<AgentRequest>(line, serializerOptions) ?? throw new InvalidOperationException("Agent request was empty.");
						object? result = await DispatchAsync(pool, account, request).ConfigureAwait(continueOnCapturedContext: false);
						value = new AgentResponse(request.Id, Ok: true, result);
					}
					catch (Exception ex)
					{
						value = new AgentResponse(TryReadRequestId(line, serializerOptions), Ok: false, null, ex.Message);
					}
					await Console.Out.WriteLineAsync(JsonSerializer.Serialize(value, serializerOptions)).ConfigureAwait(continueOnCapturedContext: false);
					await Console.Out.FlushAsync().ConfigureAwait(continueOnCapturedContext: false);
					continue;
				}
				break;
			}
		}
		catch (Exception ex2)
		{
			Console.Error.WriteLine("Local Browser Agent startup failed: " + ex2.Message);
			Environment.ExitCode = 2;
		}
		static async Task<object?> DispatchAsync(BrowserWorkerPool browserWorkerPool, AgentAccount account2, AgentRequest agentRequest)
		{
			return agentRequest.Method switch
			{
				"describe" => new AgentDescription(account2, "separate-process-stdio-ipc"),
				"metrics" => browserWorkerPool.Metrics(),
				"start" => browserWorkerPool.Start(Required(agentRequest.User, "user"), Required(agentRequest.AccountId, "accountId")),
				"status" => browserWorkerPool.Status(Required(agentRequest.User, "user")),
				"handoff" => await browserWorkerPool.HandoffAsync(Required(agentRequest.User, "user"), CancellationToken.None).ConfigureAwait(continueOnCapturedContext: false),
				"input" => new
				{
					accepted = await browserWorkerPool.InputAsync(Required(agentRequest.User, "user"), agentRequest.Input ?? throw new InvalidOperationException("input is required.")).ConfigureAwait(continueOnCapturedContext: false)
				},
				"frame" => await FrameAsync(browserWorkerPool, Required(agentRequest.User, "user")).ConfigureAwait(continueOnCapturedContext: false),
				"end" => await EndAsync(browserWorkerPool, Required(agentRequest.User, "user")).ConfigureAwait(continueOnCapturedContext: false),
				"close" => null,
				_ => throw new InvalidOperationException("Unknown Agent method."),
			};
		}
		static async Task<object> EndAsync(BrowserWorkerPool browserWorkerPool, string user)
		{
			await browserWorkerPool.EndAsync(user).ConfigureAwait(continueOnCapturedContext: false);
			return new
			{
				ended = true
			};
		}
		static async Task<object> FrameAsync(BrowserWorkerPool browserWorkerPool, string user)
		{
			byte[]? array = await browserWorkerPool.FrameAsync(user).ConfigureAwait(continueOnCapturedContext: false);
			return new
			{
				base64 = ((array == null) ? null : Convert.ToBase64String(array))
			};
		}
		static string Required(string? text2, string name)
		{
			if (string.IsNullOrWhiteSpace(text2))
			{
				throw new InvalidOperationException(name + " is required.");
			}
			return text2;
		}
		static long TryReadRequestId(string json, JsonSerializerOptions options)
		{
			try
			{
				return JsonSerializer.Deserialize<AgentRequest>(json, options)?.Id ?? 0;
			}
			catch (JsonException)
			{
				return 0L;
			}
		}
	}
}

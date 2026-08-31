namespace SsoGeminiLogin.Agent;

internal sealed record AgentResponse(long Id, bool Ok, object? Result = null, string? Error = null);

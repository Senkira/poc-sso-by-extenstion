namespace SsoGeminiLogin.Agent;

internal sealed record AgentRequest(long Id, string Method, string? User = null, string? AccountId = null, AgentInput? Input = null);

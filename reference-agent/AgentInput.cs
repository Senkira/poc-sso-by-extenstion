namespace SsoGeminiLogin.Agent;

internal sealed record AgentInput(string Type, double? X, double? Y, double? DeltaY, string? Text, string? Key);

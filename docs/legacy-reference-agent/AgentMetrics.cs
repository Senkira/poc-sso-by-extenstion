namespace SsoGeminiLogin.Agent;

internal sealed record AgentMetrics(int ActiveWorkers, int MaxWorkers, int LeasedAccounts);

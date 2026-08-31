using System;

namespace SsoGeminiLogin.Agent;

internal sealed record AgentProgress(string Status, string Message, DateTimeOffset At);

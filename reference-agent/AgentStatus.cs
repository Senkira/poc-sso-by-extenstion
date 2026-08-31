using System;
using System.Collections.Generic;

namespace SsoGeminiLogin.Agent;

internal sealed record AgentStatus(string Status, string? Message = null, string? Account = null, DateTimeOffset? CreatedAt = null, AgentViewport? Viewport = null, IReadOnlyList<AgentProgress>? Progress = null, bool AccountVerified = false);

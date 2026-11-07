export const AGENT_RUN_LOG_TYPES = [
  "thinking",
  "assistant_delta",
  "tool_call",
  "tool_result",
  "tool_failure",
  "plan",
  "evidence",
  "warn",
  "error",
  "status",
  "message",
] as const;

export type AgentRunLogType = (typeof AGENT_RUN_LOG_TYPES)[number];

export interface AgentRunLogEvent {
  id: number;
  runId: string;
  type: AgentRunLogType;
  content: string;
  createdAt: Date;
}

export type AgentRunLogPayload = Omit<AgentRunLogEvent, "createdAt"> & {
  createdAt: string;
};

export function isAgentRunLogType(value: unknown): value is AgentRunLogType {
  return (
    typeof value === "string" &&
    AGENT_RUN_LOG_TYPES.some((type) => type === value)
  );
}

export function isAgentRunLogPayload(
  value: unknown,
  runId: string
): value is AgentRunLogPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const event = value as Record<string, unknown>;
  return (
    event.runId === runId &&
    Number.isSafeInteger(event.id) &&
    isAgentRunLogType(event.type) &&
    typeof event.content === "string" &&
    typeof event.createdAt === "string" &&
    Number.isFinite(Date.parse(event.createdAt))
  );
}

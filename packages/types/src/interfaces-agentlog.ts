// ---------------------------------------------------------------------------
// RUN LOG TYPES
//
// Every row in AgentLog has a "type" and a "content" text. The type tells the
// reader what kind of event it is.
//
// Rule that matters most:
//   - "status" content is EXACTLY one run status word, like "RUNNING".
//     Nothing else is ever written there. The browser reads it with
//     isAgentRunStatus() and ignores anything it does not know.
//   - Human sentences ("Agent is waiting for your reply") go in "info".
//     They are shown in the Activity list. No code makes a decision from them.
// ---------------------------------------------------------------------------
export const AGENT_RUN_LOG_TYPES = [
  // "Agent iteration N" before every model call.
  "thinking",
  // Small pieces of live model text. Not kept: they are deleted when the run
  // ends and are not part of the first snapshot the browser loads.
  "assistant_delta",
  // The agent chose a tool (name + arguments).
  "tool_call",
  // The tool worked (its output).
  "tool_result",
  // The tool failed (its output).
  "tool_failure",
  // Not written by any code today.
  "plan",
  // Not written by any code today.
  "evidence",
  // Something went wrong but the run continues (for example a rate limit retry).
  "warn",
  // The run failed. Content is the reason. The browser treats it as FAILED.
  "error",
  // The run changed status. Content is ONLY a run status word (see above).
  "status",
  // Text for the chat: the agent's final answer, or its ask_human question.
  "message",
  // NEW: a plain sentence that explains what happened, for people to read.
  // Example: "Run interrupted because the server restarted".
  "info",
] as const;

export type AgentRunLogType = (typeof AGENT_RUN_LOG_TYPES)[number];

export interface AgentRunLogEvent {
  id: number;
  runId: string;
  type: AgentRunLogType;
  content: string;
  createdAt: Date;
}

// Same as AgentRunLogEvent, but as it travels over the network (JSON has no
// Date, so createdAt is a string).
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

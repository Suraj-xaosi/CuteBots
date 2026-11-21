// ---------------------------------------------------------------------------
// RUN STATUS
//
// One row in the AgentRun table is one run of the agent. This enum is the
// ONLY list of states a run can be in. The server and the browser must both
// use these exact words (never sentences) to talk about status.
//
// Lifecycle:
//   QUEUED -> RUNNING <-> WAITING_FOR_INPUT
//   RUNNING / WAITING_FOR_INPUT / QUEUED -> DONE | FAILED | INTERRUPTED
//   A terminal status is final. A new user message makes a NEW run.
// ---------------------------------------------------------------------------
export enum AgentRunStatus{
  // Row is created and the project is locked, but the loop has not started.
  // Set by: DB default (launchRun in actions/runs.ts).
  QUEUED="QUEUED",

  // The agent loop is working (model call or tool call).
  // Set by: AgentLoop.run, and again after a reply to ask_human.
  RUNNING="RUNNING",

  // The agent used ask_human and waits for the user (max 10 minutes).
  // Set by: executeAgentTools. Only a run in this state accepts a reply.
  WAITING_FOR_INPUT="WAITING_FOR_INPUT",

  // Terminal. The user pressed Stop, or the server restarted.
  // Set by: AgentLoop (abort), cancelRun/forceFinishRun, startup.ts.
  INTERRUPTED="INTERRUPTED",

  // Nobody sets this today. It is kept for the "ask before push" step that
  // we plan to add with the guardrails. It counts as ACTIVE (see below).
  AWAITING_APPROVAL="AWAITING_APPROVAL",

  // Terminal. The agent finished and the summary is saved.
  DONE="DONE",

  // Terminal. An error happened (LLM error, step limit, missing credentials,
  // sandbox problem, empty final answer).
  FAILED="FAILED"
}

// ACTIVE = the run is not finished. The browser keeps the live stream open.
export const ACTIVE_AGENT_RUN_STATUSES = [
  AgentRunStatus.QUEUED,
  AgentRunStatus.RUNNING,
  AgentRunStatus.WAITING_FOR_INPUT,
  AgentRunStatus.AWAITING_APPROVAL,
] as const;

// TERMINAL = the run is over. The project lock is released and the stream closes.
export const TERMINAL_AGENT_RUN_STATUSES = [
  AgentRunStatus.DONE,
  AgentRunStatus.FAILED,
  AgentRunStatus.INTERRUPTED,
] as const;

export enum SandboxStatus {
  STARTING = "STARTING",
  RUNNING = "RUNNING",
  STOPPED = "STOPPED",
  DESTROYING = "DESTROYING",
}

export enum ProjectProvisionStatus {
  PENDING = "PENDING",
  PROVISIONING = "PROVISIONING",
  READY = "READY",
  FAILED = "FAILED",
}

export enum MessageRole {
  USER = "user",
  ASSISTANT = "assistant",
  TOOL = "tool",
}

// Plain string versions of the enums ("RUNNING" instead of AgentRunStatus.RUNNING).
// Prisma and JSON give us these, so most code uses them.
export type AgentRunStatusValue = `${AgentRunStatus}`;
export type SandboxStatusValue = `${SandboxStatus}`;
export type ProjectProvisionStatusValue = `${ProjectProvisionStatus}`;
export type MessageRoleValue = `${MessageRole}`;

// NEW: the active and terminal statuses as their own types. The guards below
// return these, so TypeScript knows exactly which statuses are left in each
// branch of an if / else.
export type ActiveAgentRunStatusValue =
  `${(typeof ACTIVE_AGENT_RUN_STATUSES)[number]}`;
export type TerminalAgentRunStatusValue =
  `${(typeof TERMINAL_AGENT_RUN_STATUSES)[number]}`;

const ALL_AGENT_RUN_STATUSES: readonly string[] = Object.values(AgentRunStatus);

// NEW: strict check, "is this exactly one of the known run statuses?".
// The browser uses this on every status event. If it returns false the event
// is IGNORED. We never guess a status from text anymore.
export function isAgentRunStatus(value: unknown): value is AgentRunStatusValue {
  return typeof value === "string" && ALL_AGENT_RUN_STATUSES.includes(value);
}

// FIXED: this used to say "value is AgentRunStatusValue", which means "any
// status". Now it says "one of the ACTIVE statuses", so the else branch is
// correctly narrowed to the terminal statuses.
export function isActiveAgentRunStatus(
  value: string
): value is ActiveAgentRunStatusValue {
  return ACTIVE_AGENT_RUN_STATUSES.some((status) => status === value);
}

// FIXED: same fix as above, for the terminal statuses.
export function isTerminalAgentRunStatus(
  value: string
): value is TerminalAgentRunStatusValue {
  return TERMINAL_AGENT_RUN_STATUSES.some((status) => status === value);
}

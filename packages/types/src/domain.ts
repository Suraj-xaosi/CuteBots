export enum TaskStatus {
  RUNNING = "RUNNING",
  INTERRUPTED = "INTERRUPTED",
  DONE = "DONE",
  FAILED = "FAILED",
}

export enum AgentRunStatus{
  QUEUED="QUEUED",
  RUNNING="RUNNING",
  WAITING_FOR_INPUT="WAITING_FOR_INPUT",
  INTERRUPTED="INTERRUPTED",
  AWAITING_APPROVAL="AWAITING_APPROVAL",
  DONE="DONE",
  FAILED="FAILED"
}

export const ACTIVE_AGENT_RUN_STATUSES = [
  AgentRunStatus.QUEUED,
  AgentRunStatus.RUNNING,
  AgentRunStatus.WAITING_FOR_INPUT,
  AgentRunStatus.AWAITING_APPROVAL,
] as const;

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

export type AgentRunStatusValue = `${AgentRunStatus}`;
export type SandboxStatusValue = `${SandboxStatus}`;
export type ProjectProvisionStatusValue = `${ProjectProvisionStatus}`;
export type MessageRoleValue = `${MessageRole}`;

export function isActiveAgentRunStatus(
  value: string
): value is AgentRunStatusValue {
  return ACTIVE_AGENT_RUN_STATUSES.some((status) => status === value);
}

export function isTerminalAgentRunStatus(
  value: string
): value is AgentRunStatusValue {
  return TERMINAL_AGENT_RUN_STATUSES.some((status) => status === value);
}
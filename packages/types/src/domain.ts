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

export enum SandboxStatus {
  RUNNING = "RUNNING",
  STOPPED = "STOPPED",
}

export enum MessageRole {
  USER = "user",
  ASSISTANT = "assistant",
  TOOL = "tool",
}
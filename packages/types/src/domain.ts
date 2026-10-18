export enum TaskStatus {
  RUNNING = "RUNNING",
  INTERRUPTED = "INTERRUPTED",
  DONE = "DONE",
  FAILED = "FAILED",
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
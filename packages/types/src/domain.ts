export enum ProjectStatus {
  ACTIVE = "ACTIVE",
  STOPPED = "STOPPED",
}

export enum TaskStatus {
  PENDING = "PENDING",
  RUNNING = "RUNNING",
  PAUSED = "PAUSED",
  DONE = "DONE",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED",
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
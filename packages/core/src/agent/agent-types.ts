import type { LLMMessage, Result, TaskStatus } from "@workspace/types";

export interface AgentTask {
  id: string;
  projectId: string;
  description: string;
  resume?: boolean;
}

export interface StoredAgentMessage {
  taskId: string;
  projectId: string;
  role: LLMMessage["role"];
  content: string;
  toolCallsJson?: string | null;
  toolCallId?: string | null;
}

export interface AgentLogEvent {
  id: number;
  taskId: string;
  type: "thinking" | "tool_call" | "tool_result" | "warn" | "error" | "status" | "message";
  content: string;
  createdAt: Date;
}

export interface AgentPersistence {
  loadMessages(taskId: string): Promise<Result<StoredAgentMessage[]>>;
  appendMessage(message: StoredAgentMessage): Promise<Result<void>>;
  updateTaskStatus(taskId: string, status: TaskStatus, failReason?: string): Promise<Result<void>>;
  appendLog(input: Omit<AgentLogEvent, "id" | "createdAt">): Promise<Result<AgentLogEvent>>;
  listLogsAfter(taskId: string, afterId: number, limit: number): Promise<Result<AgentLogEvent[]>>;
  recordTokenUsage(taskId: string, inputTokens: number, outputTokens: number): Promise<Result<void>>;
}

export interface AgentChannel {
  sendMessage(text: string): Promise<void>;
  sendLog(event: AgentLogEvent): Promise<void>;
  waitForReply(timeoutMs: number, signal?: AbortSignal): Promise<Result<string>>;
}

export interface AgentQueueReceipt {
  queued: boolean;
  position: number;
}

export interface AgentExecutor {
  run(task: AgentTask): Promise<void>;
  stop(): void;
}
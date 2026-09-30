import {
  ErrorCode,
  TaskStatus,
  type Result,
} from "@workspace/types";
import {
  MessageRole as DatabaseMessageRole,
  TaskStatus as DatabaseTaskStatus,
  type PrismaClient,
} from "./generated/prisma/client.js";
import type {
  AgentLogEvent,
  AgentPersistence,
  StoredAgentMessage,
} from "@workspace/core/agent/agent-types";

export class PrismaAgentPersistence implements AgentPersistence {
  constructor(private readonly prisma: PrismaClient) {}

  async loadMessages(taskId: string): Promise<Result<StoredAgentMessage[]>> {
    return this.runSafely(async () => {
      const messages = await this.prisma.message.findMany({
        where: { task_id: taskId },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
      });
      return messages.map((message) => ({
        taskId: message.task_id,
        projectId: message.project_id,
        role: toAppMessageRole(message.role),
        content: message.content,
        toolCallsJson: message.tool_calls,
        toolCallId: message.tool_call_id,
      }));
    });
  }

  async appendMessage(message: StoredAgentMessage): Promise<Result<void>> {
    return this.runSafely(async () => {
      await this.prisma.message.create({
        data: {
          task_id: message.taskId,
          project_id: message.projectId,
          role: toDatabaseMessageRole(message.role),
          content: message.content,
          tool_calls: message.toolCallsJson ?? null,
          tool_call_id: message.toolCallId ?? null,
        },
      });
    });
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    failReason?: string,
  ): Promise<Result<void>> {
    return this.runSafely(async () => {
      await this.prisma.task.update({
        where: { id: taskId },
        data: {
          status: toDatabaseTaskStatus(status),
          fail_reason: failReason ?? null,
        },
      });
    });
  }

  async appendLog(
    input: Omit<AgentLogEvent, "id" | "createdAt">,
  ): Promise<Result<AgentLogEvent>> {
    return this.runSafely(async () => {
      const log = await this.prisma.agentLog.create({
        data: { task_id: input.taskId, type: input.type, content: input.content },
      });
      return {
        id: log.id,
        taskId: log.task_id,
        type: toAgentLogType(log.type),
        content: log.content,
        createdAt: log.created_at,
      };
    });
  }

  async listLogsAfter(
    taskId: string,
    afterId: number,
    limit: number,
  ): Promise<Result<AgentLogEvent[]>> {
    return this.runSafely(async () => {
      const logs = await this.prisma.agentLog.findMany({
        where: { task_id: taskId, id: { gt: afterId } },
        orderBy: { id: "asc" },
        take: Math.max(1, Math.min(1_000, Math.floor(limit))),
      });
      return logs.map((log) => ({
        id: log.id,
        taskId: log.task_id,
        type: toAgentLogType(log.type),
        content: log.content,
        createdAt: log.created_at,
      }));
    });
  }

  async recordTokenUsage(
    taskId: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<Result<void>> {
    return this.runSafely(async () => {
      await this.prisma.tokenUsage.create({
        data: {
          task_id: taskId,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
      });
    });
  }

  private async runSafely<T>(operation: () => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, data: await operation() };
    } catch (error) {
      const code = prismaErrorCode(error);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Database operation failed",
        code,
      };
    }
  }
}

function toDatabaseTaskStatus(status: TaskStatus): DatabaseTaskStatus {
  switch (status) {
    case TaskStatus.PENDING: return DatabaseTaskStatus.PENDING;
    case TaskStatus.RUNNING: return DatabaseTaskStatus.RUNNING;
    case TaskStatus.PAUSED: return DatabaseTaskStatus.PAUSED;
    case TaskStatus.DONE: return DatabaseTaskStatus.DONE;
    case TaskStatus.FAILED: return DatabaseTaskStatus.FAILED;
    case TaskStatus.CANCELLED: return DatabaseTaskStatus.CANCELLED;
  }
}

function toDatabaseMessageRole(role: StoredAgentMessage["role"]): DatabaseMessageRole {
  switch (role) {
    case "user": return DatabaseMessageRole.user;
    case "assistant": return DatabaseMessageRole.assistant;
    case "tool": return DatabaseMessageRole.tool;
  }
}

function toAppMessageRole(role: DatabaseMessageRole): StoredAgentMessage["role"] {
  switch (role) {
    case DatabaseMessageRole.user: return "user";
    case DatabaseMessageRole.assistant: return "assistant";
    case DatabaseMessageRole.tool: return "tool";
  }
}

function toAgentLogType(type: string): AgentLogEvent["type"] {
  switch (type) {
    case "thinking":
    case "tool_call":
    case "tool_result":
    case "warn":
    case "error":
    case "status":
    case "message":
      return type;
    default:
      return "warn";
  }
}

function prismaErrorCode(error: unknown): ErrorCode {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "P2025") {
    return ErrorCode.TASK_NOT_FOUND;
  }
  return ErrorCode.TOOL_EXECUTION_FAILED;
}


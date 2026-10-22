import {
  AgentRunStatus,
  ErrorCode,
  type Result,
} from "@workspace/types";
import {
  AgentRunStatus as DatabaseAgentRunStatus,
  MessageRole as DatabaseMessageRole,
  type PrismaClient,
} from "@workspace/db";
import type {
  AgentRunLogEvent,
  AgentRunLogType,
  AgentRunPersistence,
  StoredConversationMessage,
} from "@workspace/core/agent/agent-types";

export class PrismaAgentPersistence implements AgentRunPersistence {
  constructor(private readonly prisma: PrismaClient) {}

  async loadConversationMessages(
    conversationId: string,
  ): Promise<Result<StoredConversationMessage[]>> {
    return this.runSafely(async () => {
      const messages = await this.prisma.message.findMany({
        where: { conversation_id: conversationId },
        orderBy: [{ created_at: "asc" }, { id: "asc" }],
      });

      return messages.map((message) => ({
        conversationId: message.conversation_id,
        runId: message.run_id,
        role: toAppMessageRole(message.role),
        content: message.content,
        toolCallsJson: message.tool_calls,
        toolCallId: message.tool_call_id,
      }));
    });
  }

  async appendConversationMessage(
    message: StoredConversationMessage,
  ): Promise<Result<void>> {
    return this.runSafely(async () => {
      await this.prisma.message.create({
        data: {
          conversation_id: message.conversationId,
          run_id: message.runId ?? null,
          role: toDatabaseMessageRole(message.role),
          content: message.content,
          tool_calls: message.toolCallsJson ?? null,
          tool_call_id: message.toolCallId ?? null,
        },
      });
    });
  }

  async updateRunStatus(
    runId: string,
    status: AgentRunStatus,
    failReason?: string,
  ): Promise<Result<void>> {
    return this.runSafely(async () => {
      await this.prisma.$transaction(async (transaction) => {
        const run = await transaction.agentRun.update({
          where: { id: runId },
          data: {
            status: toDatabaseAgentRunStatus(status),
            fail_reason: failReason ?? null,
            ...(status === AgentRunStatus.RUNNING
              ? { started_at: new Date() }
              : {}),
            completed_at: isTerminalStatus(status) ? new Date() : null,
          },
          select: {
            conversation: {
              select: { project_id: true },
            },
          },
        });

        if (isTerminalStatus(status)) {
          await transaction.project.updateMany({
            where: {
              id: run.conversation.project_id,
              active_run_id: runId,
            },
            data: { active_run_id: null },
          });
        }
      });
    });
  }

  async updateRunSummary(
    runId: string,
    summary: string,
  ): Promise<Result<void>> {
    return this.runSafely(async () => {
      await this.prisma.agentRun.update({
        where: { id: runId },
        data: { completion_summary: summary },
      });
    });
  }

  async appendRunLog(
    input: Omit<AgentRunLogEvent, "id" | "createdAt">,
  ): Promise<Result<AgentRunLogEvent>> {
    return this.runSafely(async () => {
      const log = await this.prisma.agentLog.create({
        data: {
          run_id: input.runId,
          type: input.type,
          content: input.content,
        },
      });

      return {
        id: log.id,
        runId: log.run_id,
        type: toAgentRunLogType(log.type),
        content: log.content,
        createdAt: log.created_at,
      };
    });
  }

  async listRunLogsAfter(
    runId: string,
    afterId: number,
    limit: number,
  ): Promise<Result<AgentRunLogEvent[]>> {
    return this.runSafely(async () => {
      const logs = await this.prisma.agentLog.findMany({
        where: { run_id: runId, id: { gt: afterId } },
        orderBy: { id: "asc" },
        take: Math.max(1, Math.min(1_000, Math.floor(limit))),
      });

      return logs.map((log) => ({
        id: log.id,
        runId: log.run_id,
        type: toAgentRunLogType(log.type),
        content: log.content,
        createdAt: log.created_at,
      }));
    });
  }

  private async runSafely<T>(operation: () => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, data: await operation() };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : "Database operation failed",
        code: prismaErrorCode(error),
      };
    }
  }
}

function toDatabaseAgentRunStatus(status: AgentRunStatus) {
  switch (status) {
    case AgentRunStatus.QUEUED:
      return DatabaseAgentRunStatus.QUEUED;
    case AgentRunStatus.RUNNING:
      return DatabaseAgentRunStatus.RUNNING;
    case AgentRunStatus.WAITING_FOR_INPUT:
      return DatabaseAgentRunStatus.WAITING_FOR_INPUT;
    case AgentRunStatus.INTERRUPTED:
      return DatabaseAgentRunStatus.INTERRUPTED;
    case AgentRunStatus.AWAITING_APPROVAL:
      return DatabaseAgentRunStatus.AWAITING_APPROVAL;
    case AgentRunStatus.DONE:
      return DatabaseAgentRunStatus.DONE;
    case AgentRunStatus.FAILED:
      return DatabaseAgentRunStatus.FAILED;
  }
}

function isTerminalStatus(status: AgentRunStatus): boolean {
  return (
    status === AgentRunStatus.INTERRUPTED ||
    status === AgentRunStatus.DONE ||
    status === AgentRunStatus.FAILED
  );
}

function toDatabaseMessageRole(role: StoredConversationMessage["role"]) {
  switch (role) {
    case "user":
      return DatabaseMessageRole.user;
    case "assistant":
      return DatabaseMessageRole.assistant;
    case "tool":
      return DatabaseMessageRole.tool;
  }
}

function toAppMessageRole(role: DatabaseMessageRole) {
  switch (role) {
    case DatabaseMessageRole.user:
      return "user";
    case DatabaseMessageRole.assistant:
      return "assistant";
    case DatabaseMessageRole.tool:
      return "tool";
  }
}

function toAgentRunLogType(type: string): AgentRunLogType {
  switch (type) {
    case "thinking":
    case "assistant_delta":
    case "tool_call":
    case "tool_result":
    case "tool_failure":
    case "plan":
    case "evidence":
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
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2025"
  ) {
    return ErrorCode.TASK_NOT_FOUND;
  }

  return ErrorCode.TOOL_EXECUTION_FAILED;
}
import 'server-only'

import {
  redactTextSecrets,
  type AgentRunLogEvent,
  type AgentRunPersistence,
  type StoredConversationMessage,
} from '@workspace/core'
import {
  AgentRunStatus as DbRunStatus,
  MessageRole,
  prisma,
} from '@workspace/db'
import { AgentRunStatus, ErrorCode, isTerminalAgentRunStatus } from '@workspace/types'

const runStatus = {
  [AgentRunStatus.QUEUED]: DbRunStatus.QUEUED,
  [AgentRunStatus.RUNNING]: DbRunStatus.RUNNING,
  [AgentRunStatus.WAITING_FOR_INPUT]: DbRunStatus.WAITING_FOR_INPUT,
  [AgentRunStatus.INTERRUPTED]: DbRunStatus.INTERRUPTED,
  [AgentRunStatus.AWAITING_APPROVAL]: DbRunStatus.AWAITING_APPROVAL,
  [AgentRunStatus.DONE]: DbRunStatus.DONE,
  [AgentRunStatus.FAILED]: DbRunStatus.FAILED,
}

export const persistence: AgentRunPersistence = {
  async loadConversationMessages(conversationId) {
    try {
      const messages = await prisma.message.findMany({
        where: { conversation_id: conversationId },
        // id as tie-breaker: two messages in the same millisecond must keep their order.
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      })

      return {
        ok: true,
        data: messages.map(
          (message): StoredConversationMessage => ({
            conversationId,
            runId: message.run_id,
            role:
              message.role === MessageRole.user
                ? 'user'
                : message.role === MessageRole.assistant
                  ? 'assistant'
                  : 'tool',
            content: redactTextSecrets(message.content),
            toolCallsJson: message.tool_calls,
            toolCallId: message.tool_call_id,
          })
        ),
      }
    } catch (error) {
      console.error('Load conversation messages failed', { conversationId, error })
      return {
        ok: false,
        error: 'Unable to load conversation history',
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      }
    }
  },

  async appendConversationMessage(message) {
    try {
      const role =
        message.role === 'user'
          ? MessageRole.user
          : message.role === 'assistant'
            ? MessageRole.assistant
            : MessageRole.tool

      await prisma.message.create({
        data: {
          conversation_id: message.conversationId,
          run_id: message.runId,
          role,
          content: redactTextSecrets(message.content),
          tool_calls: message.toolCallsJson,
          tool_call_id: message.toolCallId,
        },
      })

      return { ok: true, data: undefined }
    } catch (error) {
      console.error('Append conversation message failed', { message, error })
      return {
        ok: false,
        error: 'Unable to save message',
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      }
    }
  },

  async updateRunStatus(id, status, failReason) {
    try {
      const current = await prisma.agentRun.findUnique({
        where: { id },
        select: { started_at: true, conversation: { select: { project_id: true } } },
      })
      if (!current) {
        return { ok: false, error: 'Run not found', code: ErrorCode.TASK_NOT_FOUND }
      }

      // Compare-and-set: a finished run is FINAL. A late DONE can no longer
      // overwrite INTERRUPTED (cancel / hard stop), and vice versa.
      // started_at is written once, not every time WAITING_FOR_INPUT -> RUNNING.
      await prisma.agentRun.updateMany({
        where: {
          id,
          status: { notIn: [DbRunStatus.DONE, DbRunStatus.FAILED, DbRunStatus.INTERRUPTED] },
        },
        data: {
          status: runStatus[status],
          fail_reason: failReason ? redactTextSecrets(failReason) : null,
          ...(status === AgentRunStatus.RUNNING && !current.started_at ? { started_at: new Date() } : {}),
          ...(isTerminalAgentRunStatus(status) ? { completed_at: new Date() } : {}),
        },
      })

      // Always release the project lock on a terminal status (safe to repeat).
      if (isTerminalAgentRunStatus(status)) {
        await prisma.project.updateMany({
          where: { id: current.conversation.project_id, active_run_id: id },
          data: { active_run_id: null },
        })

        // Live token fragments only matter while the run is streaming; the final text
        // is stored in Message. Without this, every run leaves thousands of rows behind.
        await prisma.agentLog
          .deleteMany({ where: { run_id: id, type: 'assistant_delta' } })
          .catch(() => null)
      }

      return { ok: true, data: undefined }
    } catch (error) {
      console.error('Update run status failed', { runId: id, status, error })
      return {
        ok: false,
        error: 'Unable to update run status',
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      }
    }
  },

  async updateRunSummary(id, summary) {
    try {
      await prisma.agentRun.update({
        where: { id },
        data: { completion_summary: redactTextSecrets(summary) },
      })
      return { ok: true, data: undefined }
    } catch (error) {
      console.error('Update run summary failed', { runId: id, error })
      return {
        ok: false,
        error: 'Unable to update run summary',
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      }
    }
  },

  async appendRunLog(input) {
    try {
      const log = await prisma.agentLog.create({
        data: {
          run_id: input.runId,
          type: input.type,
          content: redactTextSecrets(input.content),
        },
      })

      return {
        ok: true,
        data: {
          id: log.id,
          runId: log.run_id,
          type: input.type,
          content: redactTextSecrets(log.content),
          createdAt: log.created_at,
        },
      }
    } catch (error) {
      console.error('Append run log failed', { runId: input.runId, error })
      return {
        ok: false,
        error: 'Unable to save run log',
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      }
    }
  },

  async listRunLogsAfter(runId, afterId, limit) {
    try {
      const logs = await prisma.agentLog.findMany({
        where: { run_id: runId, id: { gt: afterId } },
        orderBy: { id: 'asc' },
        take: limit,
      })

      const data: AgentRunLogEvent[] = logs.map((log) => ({
        id: log.id,
        runId: log.run_id,
        type: log.type as AgentRunLogEvent['type'],
        content: log.content,
        createdAt: log.created_at,
      }))

      return { ok: true, data }
    } catch (error) {
      console.error('List run logs failed', { runId, afterId, error })
      return {
        ok: false,
        error: 'Unable to load run logs',
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      }
    }
  },
}
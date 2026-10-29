import type { AgentRunStatus, LLMMessage } from "@workspace/types"
import {
  redactStructuredSecrets,
  redactTextSecrets,
} from "../security/secret-redaction.js"
import type {
  AgentChannel,
  AgentRunContext,
  AgentRunLogType,
  AgentRunPersistence,
} from "./agent-types.js"

export async function setRunStatus(
  persistence: AgentRunPersistence,
  runId: string,
  status: AgentRunStatus,
  reason?: string
) {
  const result = await persistence.updateRunStatus(runId, status, reason)
  if (!result.ok) throw new Error(result.error)
}

export async function publishRunLog(
  persistence: AgentRunPersistence,
  channel: AgentChannel | undefined,
  runId: string,
  type: AgentRunLogType,
  content: string
) {
  const result = await persistence.appendRunLog({ runId, type, content })
  if (!result.ok) throw new Error(result.error)
  await channel?.sendLog(result.data)
}

export async function saveRunMessage(
  persistence: AgentRunPersistence,
  context: AgentRunContext,
  message: LLMMessage
) {
  const saved = await persistence.appendConversationMessage({
    conversationId: context.conversationId,
    runId: context.runId,
    role: message.role,
    content: redactTextSecrets(message.content),
    ...(message.role === "assistant" && message.tool_calls?.length
      ? {
          toolCallsJson: JSON.stringify(
            redactStructuredSecrets(message.tool_calls)
          ),
        }
      : {}),
    ...(message.role === "tool" ? { toolCallId: message.tool_call_id } : {}),
  })
  if (!saved.ok) throw new Error(saved.error)
}

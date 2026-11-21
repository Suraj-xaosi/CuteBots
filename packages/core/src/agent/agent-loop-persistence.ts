import { AgentRunStatus, type LLMMessage } from "@workspace/types"
import { redactTextSecrets } from "../secret-redaction.js"
import type {
  AgentChannel,
  AgentRunContext,
  AgentRunLogType,
  AgentRunPersistence,
} from "./agent-types.js"

// NEW: the status code only needs to SEND log events, so it asks for only that
// part of AgentChannel. This lets code outside the agent loop (for example
// agent-runtime.ts) use publishRunStatus without building a full channel.
type LogChannel = Pick<AgentChannel, "sendLog">

// Writes the new status in the database.
// CHANGED: it now returns true if the status was really changed, and false if
// the run was already finished (a finished run is final, see updateRunStatus
// in agent-persistence.ts). Old callers that ignore the result still work.
export async function setRunStatus(
  persistence: AgentRunPersistence,
  runId: string,
  status: AgentRunStatus,
  reason?: string
): Promise<boolean> {
  const result = await persistence.updateRunStatus(runId, status, reason)
  if (!result.ok) throw new Error(result.error)
  return result.data.applied
}

// Saves one log row, then sends it to the live stream.
// CHANGED: only the channel type is wider now (LogChannel). Nothing else.
export async function publishRunLog(
  persistence: AgentRunPersistence,
  channel: LogChannel | undefined,
  runId: string,
  type: AgentRunLogType,
  content: string
) {
  const result = await persistence.appendRunLog({ runId, type, content })
  if (!result.ok) throw new Error(result.error)
  await channel?.sendLog(result.data)
}

// NEW: the ONE way to change a run's status. Always use this, never write
// a "status" log by hand.
//
// Order (important):
//   1. A sentence for humans ("info", or "error" when the run failed).
//   2. The status in the database. This is the truth.
//   3. The "status" event with only the status word, like "DONE".
//
// Why this order: the browser reacts to the status event (it refetches the
// conversation). Because the database is already updated, that refetch always
// reads the new status. The status event is also the LAST event of a run.
//
// Options:
//   reason: saved in the database as the failure/stop reason. For FAILED it is
//           also written as an "error" log so it shows in the Activity list.
//   info:   a plain sentence for the Activity list.
//
// Returns false (and sends no status event) if the run was already finished,
// for example a late DONE after the user pressed Stop.
export async function publishRunStatus(
  persistence: AgentRunPersistence,
  channel: LogChannel | undefined,
  runId: string,
  status: AgentRunStatus,
  options: { reason?: string; info?: string } = {}
): Promise<boolean> {
  // 1. Words for humans. Best effort: if this fails the status must still change.
  const note: { type: AgentRunLogType; content: string } | null =
    status === AgentRunStatus.FAILED && options.reason
      ? { type: "error", content: options.reason }
      : options.info
        ? { type: "info", content: options.info }
        : null

  if (note) {
    try {
      await publishRunLog(persistence, channel, runId, note.type, note.content)
    } catch (error) {
      console.warn("Could not write the run note", { runId, error })
    }
  }

  // 2. The database. This one must work, so it is allowed to throw.
  const applied = await setRunStatus(persistence, runId, status, options.reason)
  if (!applied) return false

  // 3. The status event. The database is already right, so if this fails we only
  //    warn. Throwing here would make the caller think the run failed.
  try {
    await publishRunLog(persistence, channel, runId, "status", status)
  } catch (error) {
    console.warn("Could not send the status event", { runId, status, error })
  }
  return true
}

export async function saveRunMessage(
  persistence: AgentRunPersistence,
  context: AgentRunContext,
  message: LLMMessage
) {
  if (
    message.role === "assistant" &&
    !message.content.trim() &&
    !message.tool_calls?.length
  ) {
    return
  }

  const saved = await persistence.appendConversationMessage({
    conversationId: context.conversationId,
    runId: context.runId,
    role: message.role,
    content: redactTextSecrets(message.content),
    ...(message.role === "assistant" && message.tool_calls?.length
      ? {
          toolCallsJson: JSON.stringify(message.tool_calls),
        }
      : {}),
    ...(message.role === "tool" ? { toolCallId: message.tool_call_id } : {}),
  })
  if (!saved.ok) throw new Error(saved.error)
}

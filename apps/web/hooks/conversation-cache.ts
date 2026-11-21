import {
  isActiveAgentRunStatus,
  isAgentRunStatus,
  type ActivityItem,
  type AgentRunStatusValue,
  type ConversationDetails,
  type ConversationItem,
  type RunItem,
} from "@workspace/types"

// Pure functions only: old data in, new data out. No React, no queryClient.
// The stream and the mutations both use these, so there is one definition of
// "what a live event does to the cache".

const MAX_ACTIVITY_ITEMS = 500

// Idempotent: the same event twice (reconnect replay) changes nothing.
export function appendActivity(
  list: ActivityItem[] | undefined,
  item: ActivityItem
): ActivityItem[] {
  const current = list ?? []
  if (current.some((existing) => existing.id === item.id)) return current
  return [...current, item].slice(-MAX_ACTIVITY_ITEMS)
}

export function withRunPatch(
  conversation: ConversationDetails,
  runId: string,
  patch: Partial<RunItem>
): ConversationDetails {
  return {
    ...conversation,
    runs: conversation.runs.map((run) =>
      run.id === runId ? { ...run, ...patch } : run
    ),
  }
}

// Live messages get a "live-" id. When the run ends the conversation query is
// invalidated and these are replaced by the real rows from the server.
export function withAssistantMessage(
  conversation: ConversationDetails,
  runId: string,
  item: ActivityItem
): ConversationDetails {
  const id = `live-${item.id}`
  if (conversation.messages.some((message) => message.id === id))
    return conversation

  return {
    ...conversation,
    messages: [
      ...conversation.messages,
      {
        id,
        role: "assistant",
        content: item.content,
        runId,
        createdAt: item.createdAt,
      },
    ],
  }
}

// NEW: the sidebar list has its own cache (one entry per conversation with its
// latest run). This keeps that entry in step with the live status events, so the
// sidebar icon changes without a refetch.
// - same run                       -> change its status
// - a run the list does not know   -> it becomes the latest run, but only when
//   the latest run the list knows is already finished (a late event of an old
//   run must never replace a newer, active run)
export function withConversationRunStatus(
  list: ConversationItem[] | undefined,
  conversationId: string,
  runId: string,
  status: AgentRunStatusValue
): ConversationItem[] | undefined {
  if (!list) return list

  return list.map((item) => {
    if (item.id !== conversationId) return item

    const latest = item.latestRun
    if (latest && latest.id === runId) {
      return { ...item, latestRun: { ...latest, status } }
    }
    if (latest && isActiveAgentRunStatus(latest.status)) return item

    return {
      ...item,
      latestRun: { id: runId, status, summary: null, createdAt: new Date() },
    }
  })
}

// Reads the content of a "status" log.
// The server sends EXACTLY one status word there (like "DONE"), so we only do
// an exact match. Anything else returns null and the caller must ignore it.
// We never guess a status from a sentence anymore.
export function statusFromEventContent(content: string): AgentRunStatusValue | null {
  const word = content.trim()
  return isAgentRunStatus(word) ? word : null
}
import {
  AgentRunStatus,
  type ActivityItem,
  type AgentRunStatusValue,
  type ConversationDetails,
  type RunItem,
} from "@workspace/types"

// Pure functions only: old data in, new data out. No React, no queryClient.
// The stream and the mutations both use these, so there is one definition of
// "what a live event does to the cache".

const MAX_ACTIVITIES = 500

// Idempotent: the same event twice (reconnect replay) changes nothing.
export function appendActivity(
  list: ActivityItem[] | undefined,
  item: ActivityItem
): ActivityItem[] {
  const current = list ?? []
  if (current.some((existing) => existing.id === item.id)) return current
  return [...current, item].slice(-MAX_ACTIVITIES)
}

export function withRunPatch(
  conversation: ConversationDetails,
  runId: string,
  patch: Partial<RunItem>
): ConversationDetails {
  return {
    ...conversation,
    runs: conversation.runs.map((run) => (run.id === runId ? { ...run, ...patch } : run)),
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
  if (conversation.messages.some((message) => message.id === id)) return conversation

  return {
    ...conversation,
    messages: [
      ...conversation.messages,
      { id, role: "assistant", content: item.content, runId, createdAt: item.createdAt },
    ],
  }
}

// FRAGILE ON PURPOSE, KEPT IN ONE PLACE: the server currently sends status as
// free text. When it sends a structured status, replace only this function.
export function statusFromEventContent(content: string): AgentRunStatusValue {
  const text = content.toLowerCase()
  if (text.includes("waiting")) return AgentRunStatus.WAITING_FOR_INPUT
  if (text.includes("completed")) return AgentRunStatus.DONE
  if (text.includes("interrupted") || text.includes("cancelled")) return AgentRunStatus.INTERRUPTED
  return AgentRunStatus.RUNNING
}
import type { QueryClient } from "@tanstack/react-query"
import {
  AgentRunStatus,
  isActiveAgentRunStatus,
  isAgentRunLogPayload,
  type ActivityItem,
  type ConversationDetails,
} from "@workspace/types"
import {
  appendActivity,
  statusFromEventContent,
  withAssistantMessage,
  withRunPatch,
} from "./convertation-cache"
import { conversationQuery, runActivityQuery } from "./queries"

// Plain module, no React. The only place that touches EventSource.
//
// Shape: one entry per runId, shared by everyone who subscribes (reference
// counted by the listener set). The first subscriber opens the connection,
// the last one to leave closes it. React reaches this through
// useSyncExternalStore (see hooks/use-run-stream.ts), so no useEffect.
//
// Flow on connect:
//   1. make sure the activity snapshot is in the cache (server action)
//   2. open EventSource with after = last cached activity id
//   3. every event is written into the cache, never into component state

export type StreamStatus = "idle" | "connecting" | "open" | "retrying"

export type RunStreamTarget = {
  runId: string
  conversationId: string
  queryClient: QueryClient
}

type Entry = {
  status: StreamStatus
  generation: number // bumped on every connect; lets stale async work bail out
  attempt: number
  disposed: boolean
  source: EventSource | null
  timer: ReturnType<typeof setTimeout> | null
  listeners: Set<() => void>
}

const MAX_BACKOFF_MS = 15_000
const entries = new Map<string, Entry>()

export function getRunStreamStatus(runId: string): StreamStatus {
  return entries.get(runId)?.status ?? "idle"
}

export function subscribeRunStream(target: RunStreamTarget, listener: () => void): () => void {
  let entry = entries.get(target.runId)
  const isNew = entry === undefined

  if (!entry) {
    entry = {
      status: "idle",
      generation: 0,
      attempt: 0,
      disposed: false,
      source: null,
      timer: null,
      listeners: new Set(),
    }
    entries.set(target.runId, entry)
  }

  const current = entry
  current.listeners.add(listener)
  if (isNew) void connect(target, current)

  return () => {
    current.listeners.delete(listener)
    if (current.listeners.size > 0) return

    current.disposed = true
    teardown(current)
    if (entries.get(target.runId) === current) entries.delete(target.runId)
  }
}

export function reconnectRunStream(target: RunStreamTarget) {
  const entry = entries.get(target.runId)
  if (!entry || entry.disposed) return
  entry.attempt = 0
  void connect(target, entry)
}

function setStatus(entry: Entry, status: StreamStatus) {
  if (entry.status === status) return
  entry.status = status
  entry.listeners.forEach((listener) => listener())
}

function teardown(entry: Entry) {
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = null
  entry.source?.close()
  entry.source = null
}

function scheduleRetry(target: RunStreamTarget, entry: Entry) {
  if (entry.disposed) return
  const delay = Math.min(1000 * 2 ** entry.attempt, MAX_BACKOFF_MS)
  entry.attempt += 1
  setStatus(entry, "retrying")
  entry.timer = setTimeout(() => void connect(target, entry), delay)
}

async function connect(target: RunStreamTarget, entry: Entry) {
  const generation = ++entry.generation
  teardown(entry)
  setStatus(entry, entry.attempt === 0 ? "connecting" : "retrying")

  try {
    // Cached forever once loaded (staleTime Infinity), so a retry reuses it.
    await target.queryClient.fetchQuery(runActivityQuery(target.runId))
  } catch {
    if (entry.disposed || generation !== entry.generation) return
    scheduleRetry(target, entry)
    return
  }
  if (entry.disposed || generation !== entry.generation) return

  // Read the cursor from the cache right now, not from a closure. After a
  // reconnect this is what keeps the replay starting at the right place.
  const after =
    target.queryClient.getQueryData(runActivityQuery(target.runId).queryKey)?.at(-1)?.id ?? 0

  const source = new EventSource(`/api/runs/${target.runId}/events?after=${after}`)
  entry.source = source

  source.onopen = () => {
    entry.attempt = 0
    setStatus(entry, "open")
  }
  source.onmessage = (event) => handleMessage(target, String(event.data))
  source.onerror = () => {
    // Do not let the browser auto-retry: it would reuse the old ?after=.
    if (entry.source !== source) return
    teardown(entry)
    scheduleRetry(target, entry)
  }
}

function handleMessage(target: RunStreamTarget, raw: string) {
  const { runId, conversationId, queryClient } = target

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    console.warn("Run stream: ignored a message that was not JSON")
    return
  }
  if (!isAgentRunLogPayload(value, runId)) return

  const item: ActivityItem = {
    id: value.id,
    runId: value.runId,
    type: value.type,
    content: value.content,
    createdAt: new Date(value.createdAt),
  }

  queryClient.setQueryData(runActivityQuery(runId).queryKey, (previous) =>
    appendActivity(previous, item)
  )

  const conversationKey = conversationQuery(conversationId).queryKey
  const patchConversation = (update: (conversation: ConversationDetails) => ConversationDetails) =>
    queryClient.setQueryData(conversationKey, (previous) => (previous ? update(previous) : previous))

  if (item.type === "status") {
    const status = statusFromEventContent(item.content)
    patchConversation((conversation) =>
      withRunPatch(
        conversation,
        runId,
        status === AgentRunStatus.DONE
          ? { status, summary: conversation.messages.at(-1)?.content ?? null }
          : { status }
      )
    )
    // Run over: swap the "live-" messages for the real ones from the server.
    if (!isActiveAgentRunStatus(status)) {
      void queryClient.invalidateQueries({ queryKey: conversationKey })
    }
    return
  }

  if (item.type === "error") {
    patchConversation((conversation) =>
      withRunPatch(conversation, runId, { status: AgentRunStatus.FAILED, failReason: item.content })
    )
    void queryClient.invalidateQueries({ queryKey: conversationKey })
    return
  }

  if (item.type === "message") {
    patchConversation((conversation) => withAssistantMessage(conversation, runId, item))
  }
}
"use client"

import { useCallback, useSyncExternalStore } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  getRunStreamStatus,
  reconnectRunStream,
  subscribeRunStream,
  type StreamStatus,
} from "./run-stream"

const noop = () => {}
const serverSnapshot = (): StreamStatus => "idle"

// useSyncExternalStore is the effect-free way to "open something when mounted,
// close it when unmounted": React calls subscribe() after commit and calls the
// returned function on unmount or when subscribe changes.
//
// Because the registry is reference counted, any number of components can call
// this with the same runId and still share one EventSource:
//   - a headless bridge in Workspace (keeps chat and activity live)
//   - RunPanel (only wants `status` and `reconnect` for its buttons)
//
// Pass enabled = false when the run is finished: subscribe becomes a no-op,
// React unsubscribes, and the connection closes by itself.
export function useRunStream({
  conversationId,
  runId,
  enabled,
}: {
  conversationId: string | null
  runId: string | null
  enabled: boolean
}) {
  const queryClient = useQueryClient()

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!enabled || !runId || !conversationId) return noop
      return subscribeRunStream({ runId, conversationId, queryClient }, listener)
    },
    [enabled, runId, conversationId, queryClient]
  )

  const getSnapshot = useCallback(
    (): StreamStatus => (runId ? getRunStreamStatus(runId) : "idle"),
    [runId]
  )

  const status = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot)

  const reconnect = useCallback(() => {
    if (!runId || !conversationId) return
    reconnectRunStream({ runId, conversationId, queryClient })
  }, [runId, conversationId, queryClient])

  return { status, reconnect }
}
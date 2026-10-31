"use client"

import { useCurrentRun } from "../../hooks/use-conversation"
import { useRunStream } from "../../hooks/use-run-stream"
import { useActiveConversationId } from "../../hooks/use-selection"

// Renders nothing. Mounted once by Workspace, so the stream is open whenever
// the active conversation has an active run, even if the run panel is
// collapsed. When the run reaches a final status `isActive` turns false,
// useRunStream unsubscribes, and the EventSource closes. No effect anywhere.
export function RunStreamBridge() {
  const conversationId = useActiveConversationId()
  const { run, isActive } = useCurrentRun(conversationId)

  useRunStream({ conversationId, runId: run?.id ?? null, enabled: isActive })

  return null
}
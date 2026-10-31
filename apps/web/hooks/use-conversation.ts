"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AgentRunStatus, isActiveAgentRunStatus } from "@workspace/types"
import { updateConversation } from "@/lib/actions/conversations"
import { cancelRun, replyToRun, submitMessage } from "@/lib/actions/runs"
import { withRunPatch } from "./convertation-cache"
import { conversationQuery, conversationsQuery } from "./queries"
import { unwrapVoid } from "./unwrap"
import { useSelectedProjectId } from "@/hooks/use-selection"

export function useConversation(conversationId: string | null) {
  return useQuery(conversationQuery(conversationId))
}

// The newest run and whether the agent is still working on it.
export function useCurrentRun(conversationId: string | null) {
  const { data } = useConversation(conversationId)
  const run = data?.runs[0] ?? null
  return { run, isActive: run !== null && isActiveAgentRunStatus(run.status) }
}

// One entry point for "user pressed send":
//   run is waiting for input -> reply to that run
//   otherwise                -> start a new run
// No optimistic update: when the mutation resolves, the conversation has
// already been refetched, so the new message appears at the same moment the
// input clears. Add onMutate later only if this feels slow.
export function useSendMessage(conversationId: string) {
  const queryClient = useQueryClient()
  const projectId = useSelectedProjectId()
  const { data: conversation } = useConversation(conversationId)

  const run = conversation?.runs[0]
  const waitingRunId = run?.status === AgentRunStatus.WAITING_FOR_INPUT ? run.id : null
  const needsTitle = !conversation?.title

  return useMutation({
    mutationFn: async (content: string) => {
      if (waitingRunId) {
        await unwrapVoid(replyToRun(waitingRunId, content))
        return
      }
      await unwrapVoid(submitMessage(conversationId, content))
      // Best effort: a failed title update must not fail the send.
      if (needsTitle) {
        await updateConversation(conversationId, content.slice(0, 48)).catch(() => undefined)
      }
    },
    // Runs on success and on failure (a failed send can still have changed
    // server state). Returning the promise keeps the mutation pending until
    // the refetch is done.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: conversationQuery(conversationId).queryKey }),
        queryClient.invalidateQueries({ queryKey: conversationsQuery(projectId).queryKey }),
      ]),
  })
}

export function useCancelRun(conversationId: string | null) {
  const queryClient = useQueryClient()
  const key = conversationQuery(conversationId).queryKey

  return useMutation({
    mutationFn: (runId: string) => unwrapVoid(cancelRun(runId)),
    onSuccess: (_result, runId) => {
      queryClient.setQueryData(key, (previous) =>
        previous ? withRunPatch(previous, runId, { status: AgentRunStatus.INTERRUPTED }) : previous
      )
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  })
}
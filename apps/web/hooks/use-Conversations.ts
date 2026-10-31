"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createConversation } from "@/lib/actions/conversations"
import { conversationQuery, conversationsQuery } from "./queries"
import { unwrap } from "./unwrap"
import { useAppDispatch } from "@/store/hooks"
import { workspaceActions } from "@/store/workspace-slice"

export function useConversations(projectId: string | null) {
  return useQuery(conversationsQuery(projectId))
}

export function useCreateConversation() {
  const queryClient = useQueryClient()
  const dispatch = useAppDispatch()

  return useMutation({
    mutationFn: (projectId: string) => unwrap(createConversation(projectId)),
    onSuccess: (created, projectId) => {
      // Seed both caches from the response, then select it. No refetch needed.
      queryClient.setQueryData(conversationsQuery(projectId).queryKey, (previous) => [
        created,
        ...(previous ?? []),
      ])
      queryClient.setQueryData(conversationQuery(created.id).queryKey, {
        ...created,
        messages: [],
        runs: [],
      })
      dispatch(workspaceActions.conversationSelected(created.id))
    },
  })
}
"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createConversation,
  deleteConversation,
} from "@/lib/actions/conversations"
import { conversationQuery, conversationsQuery } from "./queries"
import { unwrap } from "./unwrap"
import { useAppDispatch } from "@/store/hooks"
import { workspaceActions } from "@/store/workspace-slice"

export function useConversations(selectedProjectId: string | null) {
  return useQuery(conversationsQuery(selectedProjectId))
}

export function useDeleteConversation() {
  const queryClient = useQueryClient()
  const dispatch = useAppDispatch()

  return useMutation({
    mutationFn: ({
      conversationId,
    }: {
      conversationId: string
      projectId: string
    }) => unwrap(deleteConversation(conversationId, { force: true })),
    onSuccess: async (_, { conversationId, projectId }) => {
      await queryClient.invalidateQueries({
        queryKey: conversationsQuery(projectId).queryKey,
      })
      dispatch(workspaceActions.conversationSelected(null))
      queryClient.removeQueries({
        queryKey: conversationQuery(conversationId).queryKey,
      })
    },
  })
}

export function useCreateConversation() {
  const queryClient = useQueryClient()
  const dispatch = useAppDispatch()

  return useMutation({
    mutationFn: (projectId: string) => unwrap(createConversation(projectId)),
    onSuccess: (created, projectId) => {
      queryClient.setQueryData(
        conversationsQuery(projectId).queryKey,
        (previous) => [created, ...(previous ?? [])]
      )
      queryClient.setQueryData(conversationQuery(created.id).queryKey, {
        ...created,
        messages: [],
        runs: [],
      })
      dispatch(workspaceActions.conversationSelected(created.id))
    },
  })
}

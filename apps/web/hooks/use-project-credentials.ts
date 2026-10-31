"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { saveProjectCredentials } from "@/lib/actions/project-credentials"
import { projectCredentialsQuery } from "./queries"
import { unwrapVoid } from "./unwrap"

// Taken from the action itself, so the input type never goes out of sync.
export type ProjectCredentialsInput = Parameters<typeof saveProjectCredentials>[1]

// Fetches when the dialog opens (open = true), always fresh (staleTime 0).
// The form component should mount only after `data` exists and start its
// useState from it, so no effect is needed to copy server data into inputs.
export function useProjectCredentials(projectId: string, open: boolean) {
  return useQuery({ ...projectCredentialsQuery(projectId), enabled: open })
}

// Secret fields are never returned by the server, so the form only sends the
// ones the user typed. Success, pending and error come from the mutation.
export function useSaveProjectCredentials(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: ProjectCredentialsInput) =>
      unwrapVoid(saveProjectCredentials(projectId, input)),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: projectCredentialsQuery(projectId).queryKey }),
  })
}
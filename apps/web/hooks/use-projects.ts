"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { CreateProjectInput } from "@workspace/types"
import { createProject } from "@/lib/actions/projects"
import { projectsQuery } from "./queries"
import { unwrap } from "./unwrap"
import { useAppDispatch } from "@/store/hooks"
import { workspaceActions } from "@/store/workspace-slice"

export function useProjects() {
  return useQuery(projectsQuery())
}

// Resolves to { id, setupError? }. The dialog decides what to show for
// setupError (the project exists, but sandbox setup may have failed).
export function useCreateProject() {
  const queryClient = useQueryClient()
  const dispatch = useAppDispatch()

  return useMutation({
    mutationFn: (input: CreateProjectInput) => unwrap(createProject(input)),
    onSuccess: async (created) => {
      // Await the refetch first, so the new project is already in the list
      // when it becomes the selected one. The mutation stays pending until then.
      await queryClient.invalidateQueries({ queryKey: projectsQuery().queryKey })
      dispatch(workspaceActions.projectSelected(created.id))
    },
  })
}
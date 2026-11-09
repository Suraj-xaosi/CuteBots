"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ActionResult } from "@workspace/types"
import {
  destroySandbox,
  startSandbox,
  stopSandbox,
} from "@/lib/actions/sandbox"
import { projectsQuery, sandboxStatusQuery } from "./queries"
import { queryKeys } from "./query-keys"
import { unwrap } from "./unwrap"

export function useSandboxStatus(projectId: string, enabled: boolean) {
  return useQuery({ ...sandboxStatusQuery(projectId), enabled })
}

export function useSandboxActions(projectId: string) {
  const queryClient = useQueryClient()
  const refreshProject = async () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: sandboxStatusQuery(projectId).queryKey,
      }),
      queryClient.invalidateQueries({ queryKey: projectsQuery().queryKey }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectDirectory(projectId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectFile(projectId),
      }),
    ])

  const useAction = <T>(action: () => Promise<ActionResult<T>>) =>
    useMutation({
      mutationFn: () => unwrap(action()),
      onSuccess: refreshProject,
    })

  return {
    start: useAction(() => startSandbox(projectId)),
    stop: useAction(() => stopSandbox(projectId)),
    destroy: useAction(() => destroySandbox(projectId)),
  }
}

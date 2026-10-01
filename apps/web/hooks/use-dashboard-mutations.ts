"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"

import {
  cancelTask,
  createProject,
  createTask,
  destroySandbox,
  replyToTask,
  resumeTask,
  startSandbox,
  updateSettings,
  type CreateProjectInput,
  type ProjectSummary,
} from "@/lib/agent-api"
import { dashboardQueryKeys } from "@/hooks/use-dashboard-queries"

interface DashboardMutationCallbacks {
  onNotice: (notice: string) => void
  onProjectCreated: (project: ProjectSummary) => void
  onTaskCreated: (taskId: string) => void
}

export function useDashboardMutations({
  onNotice,
  onProjectCreated,
  onTaskCreated,
}: DashboardMutationCallbacks) {
  const queryClient = useQueryClient()
  const handleMutationError = (error: Error) => onNotice(error.message)

  const createProjectMutation = useMutation({
    mutationFn: (input: CreateProjectInput) => createProject(input),
    onSuccess: async (created) => {
      onProjectCreated(created)
      onNotice("Project created. Preparing its sandbox.")
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projects })
    },
    onError: handleMutationError,
  })

  const createTaskMutation = useMutation({
    mutationFn: ({ projectId, description }: { projectId: string; description: string }) =>
      createTask(projectId, description),
    onSuccess: async (created, variables) => {
      onTaskCreated(created.task.id)
      onNotice(created.queued ? `Task queued at position ${created.position}.` : "Task started.")
      await queryClient.invalidateQueries({
        queryKey: dashboardQueryKeys.projectTasks(variables.projectId),
      })
    },
    onError: handleMutationError,
  })

  const sandboxMutation = useMutation({
    mutationFn: ({ projectId, running }: { projectId: string; running: boolean }) =>
      running ? destroySandbox(projectId) : startSandbox(projectId),
    onSuccess: async (updated) => {
      onNotice(updated.sandbox_status === "RUNNING" ? "Sandbox started." : "Sandbox destroyed.")
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projects }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projectTasks(updated.id) }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projectFiles(updated.id) }),
      ])
    },
    onError: handleMutationError,
  })

  const taskActionMutation = useMutation({
    mutationFn: ({
      taskId,
      action,
    }: {
      projectId: string
      taskId: string
      action: "cancel" | "resume"
    }) => (action === "cancel" ? cancelTask(taskId) : resumeTask(taskId)),
    onSuccess: async (_result, variables) => {
      onNotice(variables.action === "cancel" ? "Cancellation requested." : "Task resumed.")
      await queryClient.invalidateQueries({
        queryKey: dashboardQueryKeys.projectTasks(variables.projectId),
      })
    },
    onError: handleMutationError,
  })

  const replyMutation = useMutation({
    mutationFn: ({ taskId, reply }: { taskId: string; reply: string }) => replyToTask(taskId, reply),
    onSuccess: () => onNotice("Reply sent."),
    onError: handleMutationError,
  })

  const settingsMutation = useMutation({
    mutationFn: (values: Record<string, string>) => updateSettings(values),
    onSuccess: async () => {
      onNotice("Settings saved.")
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.settings })
    },
    onError: handleMutationError,
  })

  return {
    createProject: createProjectMutation,
    createTask: createTaskMutation,
    sandbox: sandboxMutation,
    taskAction: taskActionMutation,
    reply: replyMutation,
    saveSettings: settingsMutation,
  }
}

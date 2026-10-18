"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"

import {
  cancelTask,
  createProject,
  createTask,
  destroySandbox,
  replyToTask,
  retryProjectProvisioning,
  resumeTask,
  startSandbox,
  updateProjectContext,
  updateProjectGithubToken,
  updateSettings,
  type CreateProjectInput,
  type ProjectSummary,
  type SettingsUpdateInput,
} from "@/lib/agent-api"
import { dashboardQueryKeys } from "@/hooks/use-dashboard-queries"

interface DashboardMutationCallbacks {
  onProjectCreated: (project: ProjectSummary) => void
  onTaskCreated: (taskId: string) => void
}

export function useDashboardMutations({
  onProjectCreated,
  onTaskCreated,
}: DashboardMutationCallbacks) {
  const queryClient = useQueryClient()

  const createProjectMutation = useMutation({
    mutationFn: (input: CreateProjectInput) => createProject(input),
    onSuccess: async (created) => {
      onProjectCreated(created)
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projects })
    },
  })

  const createTaskMutation = useMutation({
    mutationFn: ({ projectId, description }: { projectId: string; description: string }) =>
      createTask(projectId, description),
    onSuccess: async (created, variables) => {
      onTaskCreated(created.task.id)
      await queryClient.invalidateQueries({
        queryKey: dashboardQueryKeys.projectTasks(variables.projectId),
      })
    },
  })

  const sandboxMutation = useMutation({
    mutationFn: ({ projectId, running }: { projectId: string; running: boolean }) =>
      running ? destroySandbox(projectId) : startSandbox(projectId),
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projects }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projectTasks(updated.id) }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projectFiles(updated.id) }),
      ])
    },
  })

  const provisioningRetryMutation = useMutation({
    mutationFn: retryProjectProvisioning,
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projects })
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projectFiles(updated.id) })
    },
  })

  const projectContextMutation = useMutation({
    mutationFn: ({ projectId, context }: { projectId: string; context: string }) =>
      updateProjectContext(projectId, context),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projects })
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projectTasks(updated.id) })
    },
  })

  const projectGithubTokenMutation = useMutation({
    mutationFn: ({ projectId, githubToken }: { projectId: string; githubToken: string }) =>
      updateProjectGithubToken(projectId, githubToken),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projects })
    },
  })

  const taskActionMutation = useMutation({
    mutationFn: ({
      taskId,
      action,
      continuation,
    }: {
      projectId: string
      taskId: string
      action: "cancel" | "resume"
      continuation?: string
    }) => (action === "cancel" ? cancelTask(taskId) : resumeTask(taskId, continuation ?? "")),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({
        queryKey: dashboardQueryKeys.projectTasks(variables.projectId),
      })
    },
  })

  const replyMutation = useMutation({
    mutationFn: ({ taskId, reply }: { taskId: string; reply: string }) => replyToTask(taskId, reply),
  })

  const settingsMutation = useMutation({
    mutationFn: (values: SettingsUpdateInput) => updateSettings(values),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.settings })
    },
  })

  return {
    createProject: createProjectMutation,
    createTask: createTaskMutation,
    sandbox: sandboxMutation,
    provisioningRetry: provisioningRetryMutation,
    projectContext: projectContextMutation,
    projectGithubToken: projectGithubTokenMutation,
    taskAction: taskActionMutation,
    reply: replyMutation,
    saveSettings: settingsMutation,
  }
}

"use client"

import { useQuery } from "@tanstack/react-query"

import {
  fetchFileContent,
  fetchProjectFiles,
  fetchProjectTasks,
  fetchProjects,
  fetchSettings,
  fetchTaskMessages,
} from "@/lib/agent-api"
import {
  activeTaskStatuses,
  dashboardRefreshIntervals,
  requireDashboardValue,
} from "@/lib/dashboard"

export const dashboardQueryKeys = {
  projects: ["projects"] as const,
  projectTasks: (projectId: string | null) => ["project-tasks", projectId] as const,
  taskMessages: (taskId: string | null) => ["task-messages", taskId] as const,
  projectFiles: (projectId: string | null) => ["project-files", projectId] as const,
  fileContent: (projectId: string | null, filePath: string | null) =>
    ["file-content", projectId, filePath] as const,
  settings: ["settings"] as const,
}

export function useProjectsQuery() {
  return useQuery({
    queryKey: dashboardQueryKeys.projects,
    queryFn: fetchProjects,
    refetchInterval: (query) =>
      query.state.data?.some((project) => project.provision_status === "PROVISIONING")
        ? 1_500
        : false,
  })
}

export function useProjectTasksQuery(projectId: string | null) {
  return useQuery({
    queryKey: dashboardQueryKeys.projectTasks(projectId),
    queryFn: () => fetchProjectTasks(requireDashboardValue(projectId, "Project")),
    enabled: Boolean(projectId),
    refetchInterval: (query) =>
      query.state.data?.some((task) => activeTaskStatuses.has(task.status))
        ? dashboardRefreshIntervals.activeTasks
        : false,
  })
}

export function useTaskMessagesQuery(taskId: string | null, taskRunning: boolean) {
  return useQuery({
    queryKey: dashboardQueryKeys.taskMessages(taskId),
    queryFn: () => fetchTaskMessages(requireDashboardValue(taskId, "Task")),
    enabled: Boolean(taskId),
    refetchInterval: (query) => taskRunning && !query.state.data?.length ? 500 : false,
  })
}

export function useProjectFilesQuery(
  projectId: string | null,
  sandboxRunning: boolean,
  provisionReady: boolean,
  hasActiveTasks: boolean,
) {
  return useQuery({
    queryKey: dashboardQueryKeys.projectFiles(projectId),
    queryFn: () => fetchProjectFiles(requireDashboardValue(projectId, "Project")),
    enabled: Boolean(projectId && sandboxRunning && provisionReady),
    refetchInterval: hasActiveTasks ? dashboardRefreshIntervals.activeTaskFiles : false,
  })
}

export function useFileContentQuery(
  projectId: string | null,
  filePath: string | null,
  provisionReady: boolean,
  hasActiveTasks: boolean,
) {
  return useQuery({
    queryKey: dashboardQueryKeys.fileContent(projectId, filePath),
    queryFn: () =>
      fetchFileContent(
        requireDashboardValue(projectId, "Project"),
        requireDashboardValue(filePath, "File path"),
      ),
    enabled: Boolean(projectId && filePath && provisionReady),
    refetchInterval: hasActiveTasks ? dashboardRefreshIntervals.activeTasks : false,
  })
}

export function useSettingsQuery(enabled: boolean) {
  return useQuery({
    queryKey: dashboardQueryKeys.settings,
    queryFn: fetchSettings,
    enabled,
    refetchInterval: enabled ? dashboardRefreshIntervals.openSettings : false,
  })
}

"use client"

import { useQuery } from "@tanstack/react-query"

import {
  fetchFileContent,
  fetchProjectFiles,
  fetchProjectTasks,
  fetchProjects,
  fetchSettings,
  fetchTaskUsage,
} from "@/lib/agent-api"
import {
  activeTaskStatuses,
  dashboardRefreshIntervals,
  requireDashboardValue,
} from "@/lib/dashboard"

export const dashboardQueryKeys = {
  projects: ["projects"] as const,
  projectTasks: (projectId: string | null) => ["project-tasks", projectId] as const,
  projectFiles: (projectId: string | null) => ["project-files", projectId] as const,
  fileContent: (projectId: string | null, filePath: string | null) =>
    ["file-content", projectId, filePath] as const,
  settings: ["settings"] as const,
  taskUsage: (taskId: string | null) => ["task-usage", taskId] as const,
}

export function useProjectsQuery() {
  return useQuery({ queryKey: dashboardQueryKeys.projects, queryFn: fetchProjects })
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

export function useProjectFilesQuery(projectId: string | null, sandboxRunning: boolean, hasActiveTasks: boolean) {
  return useQuery({
    queryKey: dashboardQueryKeys.projectFiles(projectId),
    queryFn: () => fetchProjectFiles(requireDashboardValue(projectId, "Project")),
    enabled: Boolean(projectId && sandboxRunning),
    refetchInterval: hasActiveTasks ? dashboardRefreshIntervals.activeTaskFiles : false,
  })
}

export function useFileContentQuery(
  projectId: string | null,
  filePath: string | null,
  hasActiveTasks: boolean,
) {
  return useQuery({
    queryKey: dashboardQueryKeys.fileContent(projectId, filePath),
    queryFn: () =>
      fetchFileContent(
        requireDashboardValue(projectId, "Project"),
        requireDashboardValue(filePath, "File path"),
      ),
    enabled: Boolean(projectId && filePath),
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

export function useTaskUsageQuery(taskId: string | null, isActive: boolean) {
  return useQuery({
    queryKey: dashboardQueryKeys.taskUsage(taskId),
    queryFn: () => fetchTaskUsage(requireDashboardValue(taskId, "Task")),
    enabled: Boolean(taskId),
    refetchInterval: isActive ? dashboardRefreshIntervals.activeTaskUsage : false,
  })
}

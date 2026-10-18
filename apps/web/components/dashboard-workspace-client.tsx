"use client"

import { useCallback, useMemo, useState } from "react"
import { RefreshCw } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { DashboardWorkspaceLayout } from "@/components/dashboard-workspace-layout"
import {
  DashboardDialogsProvider,
  DashboardFilesProvider,
  DashboardTasksProvider,
  DashboardWorkspaceProvider,
} from "@/contexts/dashboard-context"
import { activeTaskStatuses } from "@/lib/dashboard"
import type { ProjectSummary, SettingsUpdateInput, TaskSummary } from "@/lib/agent-api"
import { useDashboardMutations } from "@/hooks/use-dashboard-mutations"
import { useDashboardContentState } from "@/hooks/use-dashboard-content-state"
import {
  useFileContentQuery,
  useProjectFilesQuery,
  useProjectTasksQuery,
  useProjectsQuery,
  useSettingsQuery,
} from "@/hooks/use-dashboard-queries"
import { useTaskStream } from "@/hooks/use-task-stream"

const EMPTY_PROJECTS: ProjectSummary[] = []
const EMPTY_TASKS: TaskSummary[] = []
const EMPTY_FILES: string[] = []

export function DashboardWorkspaceClient() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [projectSettingsId, setProjectSettingsId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [showProjectForm, setShowProjectForm] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const projectsQuery = useProjectsQuery()
  const projects = projectsQuery.data ?? EMPTY_PROJECTS
  const project = projects.find((item) => item.id === selectedProjectId) ?? projects[0] ?? null
  const tasksQuery = useProjectTasksQuery(project?.id ?? null)
  const tasks = tasksQuery.data ?? EMPTY_TASKS
  const task = tasks.find((item) => item.id === selectedTaskId) ?? tasks[0] ?? null
  const hasActiveTasks = tasks.some((item) => activeTaskStatuses.has(item.status))
  const filesQuery = useProjectFilesQuery(
    project?.id ?? null,
    project?.sandbox_status === "RUNNING",
    project?.provision_status === "READY",
    hasActiveTasks,
  )
  const files = filesQuery.data ?? EMPTY_FILES
  const selectedFile = selectedFileId && files.includes(selectedFileId) ? selectedFileId : files[0] ?? null
  const fileQuery = useFileContentQuery(
    project?.id ?? null,
    selectedFile,
    project?.provision_status === "READY",
    hasActiveTasks,
  )
  const settingsQuery = useSettingsQuery(showSettings)
  const stream = useTaskStream(task?.id ?? null)

  const openProjectForm = useCallback(() => setShowProjectForm(true), [])
  const openProjectSettings = useCallback((id: string) => setProjectSettingsId(id), [])
  const closeProjectSettings = useCallback(() => setProjectSettingsId(null), [])
  const openSettings = useCallback(() => setShowSettings(true), [])
  const closeProjectForm = useCallback(() => setShowProjectForm(false), [])
  const closeSettings = useCallback(() => setShowSettings(false), [])
  const mutations = useDashboardMutations({
    onProjectCreated: (created) => {
      closeProjectForm()
      setSelectedProjectId(created.id)
    },
    onTaskCreated: setSelectedTaskId,
  })
  const sandboxMutate = mutations.sandbox.mutate
  const sandboxPending = mutations.sandbox.isPending
  const projectId = project?.id
  const retryProvisioning = mutations.provisioningRetry.mutate
  const onRetryProvisioning = useCallback(() => {
    if (projectId) retryProvisioning(projectId)
  }, [projectId, retryProvisioning])
  const sandboxRunning = project?.sandbox_status === "RUNNING"
  const onSandboxToggle = useCallback(() => {
    if (!projectId) return
    sandboxMutate({ projectId, running: sandboxRunning })
  }, [projectId, sandboxRunning, sandboxMutate])
  const workspaceValue = useMemo(
    () => ({
      projects,
      project,
      onSelectProject: setSelectedProjectId,
      onOpenProjectSettings: openProjectSettings,
      onNewProject: openProjectForm,
      onOpenSettings: openSettings,
      onSandboxToggle,
      sandboxPending,
      sandboxError: mutations.sandbox.isError ? mutations.sandbox.error.message : null,
      onRetryProvisioning,
      provisioningRetryPending: mutations.provisioningRetry.isPending,
      provisioningRetryError: mutations.provisioningRetry.isError
        ? mutations.provisioningRetry.error.message
        : null,
    }),
    [projects, project, openProjectSettings, openProjectForm, openSettings, onSandboxToggle, sandboxPending, mutations.sandbox.isError, mutations.sandbox.error, onRetryProvisioning, mutations.provisioningRetry.isPending, mutations.provisioningRetry.isError, mutations.provisioningRetry.error],
  )
  const createTask = mutations.createTask.mutate
  const taskAction = mutations.taskAction.mutate
  const sendReply = mutations.reply.mutate
  const onCreateTask = useCallback(
    (description: string, onSuccess: () => void) => {
      if (project) createTask({ projectId: project.id, description }, { onSuccess })
    },
    [project, createTask],
  )
  const onTaskAction = useCallback(
    (action: "cancel" | "resume", continuation?: string, onSuccess?: () => void) => {
      if (!project || !task) return
      taskAction(
        { projectId: project.id, taskId: task.id, action, continuation },
        { onSuccess },
      )
    },
    [project, task, taskAction],
  )
  const onReply = useCallback(
    (reply: string, onSuccess: () => void) => {
      if (task) sendReply({ taskId: task.id, reply }, { onSuccess })
    },
    [task, sendReply],
  )
  const { tasksValue, filesValue } = useDashboardContentState({
    tasks,
    tasksLoading: tasksQuery.isPending,
    selectedTaskId: task?.id ?? null,
    onSelectTask: setSelectedTaskId,
    stream,
    onCreateTask,
    onTaskAction,
    onReply,
    taskPending: mutations.createTask.isPending,
    taskError: mutations.createTask.isError ? mutations.createTask.error.message : null,
    taskActionPending: mutations.taskAction.isPending,
    taskActionError: mutations.taskAction.isError ? mutations.taskAction.error.message : null,
    replyPending: mutations.reply.isPending,
    replyError: mutations.reply.isError ? mutations.reply.error.message : null,
    files,
    filesLoading: filesQuery.isPending,
    filesError: filesQuery.isError ? filesQuery.error.message : null,
    selectedFile,
    onSelectFile: setSelectedFileId,
    fileContent: fileQuery.data,
    fileLoading: fileQuery.isPending,
    fileError: fileQuery.isError ? fileQuery.error.message : null,
  })
  const createProject = mutations.createProject.mutate
  const saveProjectContext = mutations.projectContext.mutate
  const saveGithubToken = mutations.projectGithubToken.mutate
  const onSaveProjectContext = useCallback(
    (targetProjectId: string, context: string, onSuccess: () => void) =>
      saveProjectContext({ projectId: targetProjectId, context }, { onSuccess }),
    [saveProjectContext],
  )
  const onSaveGithubToken = useCallback(
    (targetProjectId: string, token: string, onSuccess: () => void) =>
      saveGithubToken({ projectId: targetProjectId, githubToken: token }, { onSuccess }),
    [saveGithubToken],
  )
  const saveSettings = mutations.saveSettings.mutate
  const retrySettings = settingsQuery.refetch
  const saveSettingsWithCallback = useCallback(
    (values: SettingsUpdateInput, onSuccess: () => void) => saveSettings(values, { onSuccess }),
    [saveSettings],
  )
  const dialogValue = useMemo(
    () => ({
      projectSettings: projects.find((item) => item.id === projectSettingsId) ?? null,
      onCloseProjectSettings: closeProjectSettings,
      onSaveProjectContext,
      contextSavePending: mutations.projectContext.isPending,
      contextSaveError: mutations.projectContext.isError ? mutations.projectContext.error.message : null,
      onSaveGithubToken,
      githubTokenSavePending: mutations.projectGithubToken.isPending,
      githubTokenSaveError: mutations.projectGithubToken.isError
        ? mutations.projectGithubToken.error.message
        : null,
      showProjectForm,
      onCloseProjectForm: closeProjectForm,
      onCreateProject: createProject,
      projectPending: mutations.createProject.isPending,
      projectError: mutations.createProject.isError ? mutations.createProject.error.message : null,
      showSettings,
      onCloseSettings: closeSettings,
      settings: settingsQuery.data,
      settingsError: settingsQuery.isError ? settingsQuery.error.message : null,
      settingsLoading: settingsQuery.isPending,
      onRetrySettings: () => void retrySettings(),
      onSaveSettings: saveSettingsWithCallback,
      settingsPending: mutations.saveSettings.isPending,
      settingsSaveError: mutations.saveSettings.isError ? mutations.saveSettings.error.message : null,
    }),
    [
      projectSettingsId,
      projects,
      closeProjectSettings,
      onSaveProjectContext,
      mutations.projectContext.isPending,
      mutations.projectContext.isError,
      mutations.projectContext.error,
      onSaveGithubToken,
      mutations.projectGithubToken.isPending,
      mutations.projectGithubToken.isError,
      mutations.projectGithubToken.error,
      showProjectForm,
      closeProjectForm,
      createProject,
      mutations.createProject.isPending,
      mutations.createProject.isError,
      mutations.createProject.error,
      showSettings,
      closeSettings,
      settingsQuery.data,
      settingsQuery.isError,
      settingsQuery.error,
      settingsQuery.isPending,
      retrySettings,
      saveSettingsWithCallback,
      mutations.saveSettings.isPending,
      mutations.saveSettings.isError,
      mutations.saveSettings.error,
    ],
  )

  if (projectsQuery.isPending) {
    return <main className="grid min-h-screen place-items-center bg-zinc-100 text-sm text-zinc-600">Loading workspace...</main>
  }

  if (projectsQuery.isError) {
    return (
      <main className="grid min-h-screen place-items-center bg-zinc-100 p-6">
        <div className="max-w-md border border-rose-200 bg-white p-6">
          <h1 className="font-semibold text-zinc-900">Agent API unavailable</h1>
          <p className="mt-2 text-sm text-zinc-600">{projectsQuery.error.message}</p>
          <Button className="mt-4" onClick={() => void projectsQuery.refetch()}>
            <RefreshCw className="mr-2 size-4" />
            Retry
          </Button>
        </div>
      </main>
    )
  }

  return (
    <DashboardWorkspaceProvider value={workspaceValue}>
      <DashboardTasksProvider value={tasksValue}>
        <DashboardFilesProvider value={filesValue}>
          <DashboardDialogsProvider value={dialogValue}>
            <DashboardWorkspaceLayout />
          </DashboardDialogsProvider>
        </DashboardFilesProvider>
      </DashboardTasksProvider>
    </DashboardWorkspaceProvider>
  )
}

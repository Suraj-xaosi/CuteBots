"use client"

import { useCallback, useMemo, useState } from "react"
import { FolderGit2, Plus, RefreshCw, X } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { DashboardDialogs } from "@/components/dashboard-dialogs"
import { DashboardProjectContent } from "@/components/dashboard-project-content"
import { DashboardSidebar } from "@/components/dashboard-sidebar"
import {
  DashboardDialogsProvider,
  DashboardFilesProvider,
  DashboardNoticeProvider,
  DashboardTasksProvider,
  DashboardWorkspaceProvider,
  type DashboardDialogsState,
  type DashboardFilesState,
  type DashboardNoticeState,
  type DashboardTasksState,
  type DashboardWorkspaceState,
  useDashboardNotice,
  useDashboardWorkspace,
} from "@/contexts/dashboard-context"
import { activeTaskStatuses } from "@/lib/dashboard"
import { useDashboardMutations } from "@/hooks/use-dashboard-mutations"
import {
  useFileContentQuery,
  useProjectFilesQuery,
  useProjectTasksQuery,
  useProjectsQuery,
  useSettingsQuery,
  useTaskUsageQuery,
} from "@/hooks/use-dashboard-queries"
import { useTaskStream } from "@/hooks/use-task-stream"

const EMPTY_PROJECTS: NonNullable<ReturnType<typeof useProjectsQuery>["data"]> = []
const EMPTY_TASKS: NonNullable<ReturnType<typeof useProjectTasksQuery>["data"]> = []
const EMPTY_FILES: NonNullable<ReturnType<typeof useProjectFilesQuery>["data"]> = []

export function DashboardWorkspaceClient() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [showProjectForm, setShowProjectForm] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [notice, setNotice] = useState("")

  const projectsQuery = useProjectsQuery()
  const projects = projectsQuery.data ?? EMPTY_PROJECTS
  const project = projects.find((item) => item.id === selectedProjectId) ?? projects[0] ?? null
  const tasksQuery = useProjectTasksQuery(project?.id ?? null)
  const tasks = tasksQuery.data ?? EMPTY_TASKS
  const task = tasks.find((item) => item.id === selectedTaskId) ?? tasks[0] ?? null
  const hasActiveTasks = tasks.some((item) => activeTaskStatuses.has(item.status))
  const isTaskActive = task !== null && activeTaskStatuses.has(task.status)
  const filesQuery = useProjectFilesQuery(
    project?.id ?? null,
    project?.sandbox_status === "RUNNING",
    hasActiveTasks,
  )
  const files = filesQuery.data ?? EMPTY_FILES
  const selectedFile = selectedFileId && files.includes(selectedFileId) ? selectedFileId : files[0] ?? null
  const fileQuery = useFileContentQuery(
    project?.id ?? null,
    selectedFile,
    hasActiveTasks,
  )
  const settingsQuery = useSettingsQuery(showSettings)
  const usageQuery = useTaskUsageQuery(task?.id ?? null, isTaskActive)
  const stream = useTaskStream(task?.id ?? null)

  const openProjectForm = useCallback(() => setShowProjectForm(true), [])
  const openSettings = useCallback(() => setShowSettings(true), [])
  const closeProjectForm = useCallback(() => setShowProjectForm(false), [])
  const closeSettings = useCallback(() => setShowSettings(false), [])
  const dismissNotice = useCallback(() => setNotice(""), [])
  const mutations = useDashboardMutations({
    onNotice: setNotice,
    onProjectCreated: (created) => {
      closeProjectForm()
      setSelectedProjectId(created.id)
    },
    onTaskCreated: setSelectedTaskId,
  })
  const sandboxMutate = mutations.sandbox.mutate
  const sandboxPending = mutations.sandbox.isPending
  const projectId = project?.id
  const sandboxRunning = project?.sandbox_status === "RUNNING"
  const onSandboxToggle = useCallback(() => {
    if (!projectId) return
    sandboxMutate({ projectId, running: sandboxRunning })
  }, [projectId, sandboxRunning, sandboxMutate])
  const noticeValue = useMemo<DashboardNoticeState>(
    () => ({ notice, onDismissNotice: dismissNotice }),
    [notice, dismissNotice],
  )

  const workspaceValue = useMemo<DashboardWorkspaceState>(
    () => ({
      projects,
      project,
      onSelectProject: setSelectedProjectId,
      onNewProject: openProjectForm,
      onOpenSettings: openSettings,
      onSandboxToggle,
      sandboxPending,
    }),
    [projects, project, openProjectForm, openSettings, onSandboxToggle, sandboxPending],
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
    (action: "cancel" | "resume") => {
      if (project && task) taskAction({ projectId: project.id, taskId: task.id, action })
    },
    [project, task, taskAction],
  )
  const onReply = useCallback(
    (reply: string, onSuccess: () => void) => {
      if (task) sendReply({ taskId: task.id, reply }, { onSuccess })
    },
    [task, sendReply],
  )
  const tasksValue = useMemo<DashboardTasksState>(
    () => ({
      tasks,
      tasksLoading: tasksQuery.isPending,
      selectedTaskId: task?.id ?? null,
      onSelectTask: setSelectedTaskId,
      stream,
      tokenCount: usageQuery.data?.total_tokens ?? 0,
      onCreateTask,
      onTaskAction,
      onReply,
      taskPending: mutations.createTask.isPending,
      taskActionPending: mutations.taskAction.isPending,
      replyPending: mutations.reply.isPending,
    }),
    [
      tasks,
      tasksQuery.isPending,
      task?.id,
      stream,
      usageQuery.data?.total_tokens,
      onCreateTask,
      onTaskAction,
      onReply,
      mutations.createTask.isPending,
      mutations.taskAction.isPending,
      mutations.reply.isPending,
    ],
  )
  const filesValue = useMemo<DashboardFilesState>(
    () => ({
      files,
      filesLoading: filesQuery.isPending,
      filesError: filesQuery.isError ? filesQuery.error.message : null,
      selectedFile,
      onSelectFile: setSelectedFileId,
      fileContent: fileQuery.data,
      fileLoading: fileQuery.isPending,
      fileError: fileQuery.isError ? fileQuery.error.message : null,
    }),
    [files, filesQuery.isPending, filesQuery.isError, filesQuery.error, selectedFile, fileQuery.data, fileQuery.isPending, fileQuery.isError, fileQuery.error],
  )
  const createProject = mutations.createProject.mutate
  const saveSettings = mutations.saveSettings.mutate
  const retrySettings = settingsQuery.refetch
  const saveSettingsWithCallback = useCallback(
    (values: Record<string, string>, onSuccess: () => void) => saveSettings(values, { onSuccess }),
    [saveSettings],
  )
  const dialogValue = useMemo<DashboardDialogsState>(
    () => ({
      showProjectForm,
      onCloseProjectForm: closeProjectForm,
      onCreateProject: createProject,
      projectPending: mutations.createProject.isPending,
      showSettings,
      onCloseSettings: closeSettings,
      settings: settingsQuery.data,
      settingsError: settingsQuery.isError ? settingsQuery.error.message : null,
      settingsLoading: settingsQuery.isPending,
      onRetrySettings: () => void retrySettings(),
      onSaveSettings: saveSettingsWithCallback,
      settingsPending: mutations.saveSettings.isPending,
    }),
    [
      showProjectForm,
      closeProjectForm,
      createProject,
      mutations.createProject.isPending,
      showSettings,
      closeSettings,
      settingsQuery.data,
      settingsQuery.isError,
      settingsQuery.error,
      settingsQuery.isPending,
      retrySettings,
      saveSettingsWithCallback,
      mutations.saveSettings.isPending,
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
      <DashboardNoticeProvider value={noticeValue}>
        <DashboardTasksProvider value={tasksValue}>
          <DashboardFilesProvider value={filesValue}>
            <DashboardDialogsProvider value={dialogValue}>
              <DashboardWorkspaceLayout />
            </DashboardDialogsProvider>
          </DashboardFilesProvider>
        </DashboardTasksProvider>
      </DashboardNoticeProvider>
    </DashboardWorkspaceProvider>
  )
}

function DashboardWorkspaceLayout() {
  const { project, onNewProject } = useDashboardWorkspace()
  const { notice, onDismissNotice } = useDashboardNotice()

  return (
    <main className="min-h-screen bg-zinc-100 text-zinc-900 lg:h-screen lg:overflow-hidden">
      <div className="mx-auto flex min-h-screen max-w-[1900px] flex-col lg:h-screen lg:flex-row">
        <DashboardSidebar />
        {project ? (
          <DashboardProjectContent />
        ) : (
          <section className="grid min-h-[70vh] flex-1 place-items-center p-6">
            <div className="max-w-md text-center">
              <FolderGit2 className="mx-auto size-9 text-lime-700" />
              <h2 className="mt-4 text-xl font-semibold">Create your first project</h2>
              <p className="mt-2 text-sm text-zinc-600">
                Connect a GitHub repository to create an isolated workspace and start delegating coding tasks.
              </p>
              <Button className="mt-5" onClick={onNewProject}>
                <Plus className="mr-2 size-4" />
                New project
              </Button>
            </div>
          </section>
        )}
      </div>
      {notice && (
        <div role="status" className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between border-t border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-700">
          <span>{notice}</span>
          <Button type="button" variant="ghost" size="icon" title="Dismiss" aria-label="Dismiss message" onClick={onDismissNotice}>
            <X className="size-3.5" />
          </Button>
        </div>
      )}
      <DashboardDialogs />
    </main>
  )
}

"use client"

import { useMemo } from "react"

import type { DashboardFilesState, DashboardTasksState } from "@/contexts/dashboard-context"
import type { TaskSummary } from "@/lib/agent-api"
import type { useTaskStream } from "@/hooks/use-task-stream"

interface DashboardContentStateInput {
  tasks: TaskSummary[]
  tasksLoading: boolean
  selectedTaskId: string | null
  onSelectTask: (taskId: string) => void
  stream: ReturnType<typeof useTaskStream>
  onCreateTask: DashboardTasksState["onCreateTask"]
  onTaskAction: DashboardTasksState["onTaskAction"]
  onReply: DashboardTasksState["onReply"]
  taskPending: boolean
  taskError: string | null
  taskActionPending: boolean
  taskActionError: string | null
  replyPending: boolean
  replyError: string | null
  files: string[]
  filesLoading: boolean
  filesError: string | null
  selectedFile: string | null
  onSelectFile: (file: string) => void
  fileContent: string | undefined
  fileLoading: boolean
  fileError: string | null
}

export function useDashboardContentState(input: DashboardContentStateInput) {
  const tasksValue = useMemo<DashboardTasksState>(
    () => ({
      tasks: input.tasks,
      tasksLoading: input.tasksLoading,
      selectedTaskId: input.selectedTaskId,
      onSelectTask: input.onSelectTask,
      stream: input.stream,
      onCreateTask: input.onCreateTask,
      onTaskAction: input.onTaskAction,
      onReply: input.onReply,
      taskPending: input.taskPending,
      taskError: input.taskError,
      taskActionPending: input.taskActionPending,
      taskActionError: input.taskActionError,
      replyPending: input.replyPending,
      replyError: input.replyError,
    }),
    [
      input.tasks,
      input.tasksLoading,
      input.selectedTaskId,
      input.onSelectTask,
      input.stream,
      input.onCreateTask,
      input.onTaskAction,
      input.onReply,
      input.taskPending,
      input.taskError,
      input.taskActionPending,
      input.taskActionError,
      input.replyPending,
      input.replyError,
    ],
  )
  const filesValue = useMemo<DashboardFilesState>(
    () => ({
      files: input.files,
      filesLoading: input.filesLoading,
      filesError: input.filesError,
      selectedFile: input.selectedFile,
      onSelectFile: input.onSelectFile,
      fileContent: input.fileContent,
      fileLoading: input.fileLoading,
      fileError: input.fileError,
    }),
    [
      input.files,
      input.filesLoading,
      input.filesError,
      input.selectedFile,
      input.onSelectFile,
      input.fileContent,
      input.fileLoading,
      input.fileError,
    ],
  )

  return { tasksValue, filesValue }
}

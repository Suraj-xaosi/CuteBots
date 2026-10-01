"use client"

import { createContext, useContext } from "react"

import type { CreateProjectInput, ProjectSummary, PublicSettings, TaskSummary } from "@/lib/agent-api"
import type { useTaskStream } from "@/hooks/use-task-stream"

export interface DashboardWorkspaceState {
  projects: ProjectSummary[]
  project: ProjectSummary | null
  onSelectProject: (projectId: string) => void
  onNewProject: () => void
  onOpenSettings: () => void
  onSandboxToggle: () => void
  sandboxPending: boolean
}

export interface DashboardNoticeState {
  notice: string
  onDismissNotice: () => void
}

export interface DashboardTasksState {
  tasks: TaskSummary[]
  tasksLoading: boolean
  selectedTaskId: string | null
  onSelectTask: (taskId: string) => void
  stream: ReturnType<typeof useTaskStream>
  tokenCount: number
  onCreateTask: (description: string, onSuccess: () => void) => void
  onTaskAction: (action: "cancel" | "resume") => void
  onReply: (reply: string, onSuccess: () => void) => void
  taskPending: boolean
  taskActionPending: boolean
  replyPending: boolean
}

export interface DashboardFilesState {
  files: string[]
  filesLoading: boolean
  filesError: string | null
  selectedFile: string | null
  onSelectFile: (file: string) => void
  fileContent: string | undefined
  fileLoading: boolean
  fileError: string | null
}

export interface DashboardDialogsState {
  showProjectForm: boolean
  onCloseProjectForm: () => void
  onCreateProject: (input: CreateProjectInput) => void
  projectPending: boolean
  showSettings: boolean
  onCloseSettings: () => void
  settings: PublicSettings | undefined
  settingsError: string | null
  settingsLoading: boolean
  onRetrySettings: () => void
  onSaveSettings: (values: Record<string, string>, onSuccess: () => void) => void
  settingsPending: boolean
}

const DashboardWorkspaceContext = createContext<DashboardWorkspaceState | null>(null)
const DashboardNoticeContext = createContext<DashboardNoticeState | null>(null)
const DashboardTasksContext = createContext<DashboardTasksState | null>(null)
const DashboardFilesContext = createContext<DashboardFilesState | null>(null)
const DashboardDialogsContext = createContext<DashboardDialogsState | null>(null)

export const DashboardWorkspaceProvider = DashboardWorkspaceContext.Provider
export const DashboardNoticeProvider = DashboardNoticeContext.Provider
export const DashboardTasksProvider = DashboardTasksContext.Provider
export const DashboardFilesProvider = DashboardFilesContext.Provider
export const DashboardDialogsProvider = DashboardDialogsContext.Provider

function useRequiredContext<T>(context: T | null, name: string): T {
  if (!context) throw new Error(`${name} must be used inside its dashboard provider.`)
  return context
}

export function useDashboardWorkspace() {
  return useRequiredContext(useContext(DashboardWorkspaceContext), "useDashboardWorkspace")
}

export function useDashboardNotice() {
  return useRequiredContext(useContext(DashboardNoticeContext), "useDashboardNotice")
}

export function useDashboardTasks() {
  return useRequiredContext(useContext(DashboardTasksContext), "useDashboardTasks")
}

export function useDashboardFiles() {
  return useRequiredContext(useContext(DashboardFilesContext), "useDashboardFiles")
}

export function useDashboardDialogs() {
  return useRequiredContext(useContext(DashboardDialogsContext), "useDashboardDialogs")
}

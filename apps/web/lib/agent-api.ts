const AGENT_BASE_URL = process.env.NEXT_PUBLIC_AGENT_BASE_URL ?? "http://localhost:3001"

export type ProjectStatus = "ACTIVE" | "STOPPED"
export type TaskStatus = "PENDING" | "RUNNING" | "PAUSED" | "DONE" | "FAILED" | "CANCELLED"
export type SandboxStatus = "RUNNING" | "STOPPED"

export interface ProjectSummary {
  id: string
  name: string
  repo_url: string
  container_id: string | null
  status: ProjectStatus
  sandbox_status: SandboxStatus
  sandbox_type: string
  workspace_ready: boolean
  created_at: string
}

export interface TaskSummary {
  id: string
  project_id: string
  description: string
  status: TaskStatus
  fail_reason: string | null
  created_at: string
  updated_at: string
}

export interface StreamEvent {
  id: number
  taskId: string
  type: string
  content: string
  created_at?: string
}

export interface TaskUsageSummary {
  taskId: string
  input_tokens: number
  output_tokens: number
  total_tokens: number
  latest_recorded_at: string | null
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${AGENT_BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  const text = await response.text()
  const payload = text ? (JSON.parse(text) as unknown) : null

  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload && typeof (payload as { error?: string }).error === "string"
      ? (payload as { error: string }).error
      : `Request failed with status ${response.status}`
    throw new Error(message)
  }

  return (payload as T) ?? ({} as T)
}

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const response = await apiRequest<{ projects: ProjectSummary[] }>("/api/projects/")
  return response.projects.map((project) => ({
    ...project,
    created_at: new Date(project.created_at).toISOString(),
  }))
}

export async function fetchProjectTasks(projectId: string): Promise<TaskSummary[]> {
  const response = await apiRequest<{ tasks: TaskSummary[] }>(`/api/projects/${projectId}/tasks`)
  return response.tasks.map((task) => ({
    ...task,
    created_at: new Date(task.created_at).toISOString(),
    updated_at: new Date(task.updated_at).toISOString(),
  }))
}

export async function startSandbox(projectId: string): Promise<ProjectSummary> {
  const response = await apiRequest<{ project: ProjectSummary }>(`/api/projects/${projectId}/sandbox/start`, {
    method: "POST",
  })
  return response.project
}

export async function createTask(projectId: string, description: string): Promise<{ task: TaskSummary; queued: boolean; position: number }> {
  const response = await apiRequest<{ task: TaskSummary; queued: boolean; position: number }>(`/api/projects/${projectId}/tasks`, {
    method: "POST",
    body: JSON.stringify({ description }),
  })
  return {
    ...response,
    task: {
      ...response.task,
      created_at: new Date(response.task.created_at).toISOString(),
      updated_at: new Date(response.task.updated_at ?? response.task.created_at).toISOString(),
    },
  }
}

export async function fetchTaskUsage(taskId: string): Promise<TaskUsageSummary> {
  return apiRequest<TaskUsageSummary>(`/api/tasks/${taskId}/usage`)
}

export async function cancelTask(taskId: string): Promise<void> {
  await apiRequest<void>(`/api/tasks/${taskId}/cancel`, {
    method: "POST",
  })
}

export async function replyToTask(taskId: string, reply: string): Promise<void> {
  await apiRequest<void>(`/api/tasks/${taskId}/reply`, {
    method: "POST",
    body: JSON.stringify({ reply }),
  })
}

const AGENT_BASE_PATH = "/api"

export type TaskStatus = "RUNNING" | "INTERRUPTED" | "DONE" | "FAILED"
export type SandboxStatus = "RUNNING" | "STOPPED"
export type ProjectProvisionStatus = "PENDING" | "PROVISIONING" | "READY" | "FAILED"

export interface ProjectSummary {
  id: string
  name: string
  repo_url: string
  context: string
  github_token_configured: boolean
  container_id: string | null
  branch_name: string | null
  sandbox_status: SandboxStatus
  provision_status: ProjectProvisionStatus
  provision_error: string | null
  created_at: string
  updated_at: string
}

export interface TaskSummary {
  id: string
  project_id: string
  description: string
  status: TaskStatus
  completion_summary: string | null
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

export interface TaskChatMessage {
  id: string
  role: "user" | "assistant"
  parts: Array<{ type: "text"; text: string }>
}

export interface PublicSettings {
  values: { LLM_PROVIDER?: string; LLM_MODEL?: string }
  configuredSecrets: { LLM_API_KEY?: boolean; TAVILY_API_KEY?: boolean }
}

export interface SettingsUpdateInput {
  LLM_PROVIDER?: string
  LLM_MODEL?: string
  LLM_API_KEY?: string
  TAVILY_API_KEY?: string
}

export interface CreateProjectInput {
  name: string
  repo_url: string
  github_token?: string
}

async function apiRequest<T>(path: string, init?: RequestInit) {
  const apiPath = path.startsWith("/api/") ? path.slice(4) : path
  const response = await fetch(`${AGENT_BASE_PATH}${apiPath}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text) as unknown
    } catch {
      payload = null
    }
  }

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
    updated_at: new Date(project.updated_at).toISOString(),
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

export async function fetchTaskMessages(taskId: string): Promise<TaskChatMessage[]> {
  const response = await apiRequest<{ messages: TaskChatMessage[] }>(`/tasks/${taskId}/messages`)
  return response.messages
}

export async function startSandbox(projectId: string): Promise<ProjectSummary> {
  const response = await apiRequest<{ project: ProjectSummary }>(`/api/projects/${projectId}/sandbox/start`, {
    method: "POST",
  })
  return response.project
}

export async function retryProjectProvisioning(projectId: string): Promise<ProjectSummary> {
  const response = await apiRequest<{ project: ProjectSummary }>(`/api/projects/${projectId}/provision/retry`, {
    method: "POST",
  })
  return response.project
}

export async function createTask(projectId: string, description: string): Promise<{ task: TaskSummary }> {
  const response = await apiRequest<{ task: TaskSummary }>(`/api/projects/${projectId}/tasks`, {
    method: "POST",
    body: JSON.stringify({ description }),
  })
  return { task: {
    ...response.task,
    created_at: new Date(response.task.created_at).toISOString(),
    updated_at: new Date(response.task.updated_at ?? response.task.created_at).toISOString(),
  } }
}

export async function createProject(input: CreateProjectInput): Promise<ProjectSummary> {
  const response = await apiRequest<{ project: ProjectSummary }>("/projects/", {
    method: "POST",
    body: JSON.stringify(input),
  })
  return response.project
}

export async function updateProjectContext(projectId: string, context: string): Promise<ProjectSummary> {
  const response = await apiRequest<{ project: ProjectSummary }>(`/projects/${projectId}/context`, {
    method: "PUT",
    body: JSON.stringify({ context }),
  })
  return response.project
}

export async function updateProjectGithubToken(projectId: string, githubToken: string): Promise<ProjectSummary> {
  const response = await apiRequest<{ project: ProjectSummary }>(`/projects/${projectId}/github-token`, {
    method: "PUT",
    body: JSON.stringify({ github_token: githubToken }),
  })
  return response.project
}

export async function fetchSettings(): Promise<PublicSettings> {
  return apiRequest<PublicSettings>("/settings")
}

export async function updateSettings(values: SettingsUpdateInput): Promise<PublicSettings> {
  return apiRequest<PublicSettings>("/settings", {
    method: "PUT",
    body: JSON.stringify({ values }),
  })
}

export async function destroySandbox(projectId: string): Promise<ProjectSummary> {
  const response = await apiRequest<{ project: ProjectSummary }>(`/projects/${projectId}/sandbox`, {
    method: "DELETE",
  })
  return response.project
}

export async function fetchProjectFiles(projectId: string): Promise<string[]> {
  const response = await apiRequest<{ files: string[] }>(`/projects/${projectId}/files`)
  return response.files
}

export async function fetchFileContent(projectId: string, filePath: string): Promise<string> {
  const response = await fetch(`${AGENT_BASE_PATH}/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`)
  const content = await response.text()
  if (!response.ok) {
    throw new Error(content || `Request failed with status ${response.status}`)
  }
  return content
}

export async function resumeTask(taskId: string, continuation: string): Promise<void> {
  await apiRequest(`/tasks/${taskId}/resume`, {
    method: "POST",
    body: JSON.stringify({ continuation }),
  })
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

"use client"

import { useEffect, useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Ban, FileText, FolderGit2, Play, Plus, RefreshCw, RotateCcw, Send, Settings, Square, X } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { useTaskStream } from "@/hooks/use-task-stream"
import {
  cancelTask,
  createProject,
  createTask,
  destroySandbox,
  fetchFileContent,
  fetchProjectFiles,
  fetchProjectTasks,
  fetchProjects,
  fetchSettings,
  fetchTaskUsage,
  replyToTask,
  resumeTask,
  startSandbox,
  updateSettings,
  type ProjectSummary,
  type TaskSummary,
} from "@/lib/agent-api"

const activeStatuses = new Set(["PENDING", "RUNNING"])

function statusTone(status: string): string {
  switch (status) {
    case "RUNNING": return "bg-emerald-50 text-emerald-800"
    case "PENDING": return "bg-amber-50 text-amber-800"
    case "PAUSED": return "bg-sky-50 text-sky-800"
    case "DONE": return "bg-lime-50 text-lime-900"
    case "FAILED": return "bg-rose-50 text-rose-800"
    default: return "bg-zinc-100 text-zinc-700"
  }
}

function Status({ value }: { value: string }) {
  return <span className={cn("rounded px-2 py-1 text-[11px] font-semibold", statusTone(value))}>{value.toLowerCase()}</span>
}

function Panel({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("flex min-h-0 flex-col border border-zinc-200 bg-white", className)}>
      <header className="flex min-h-11 items-center justify-between border-b border-zinc-200 px-3">
        <h2 className="text-xs font-semibold uppercase text-zinc-600">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  )
}

export function DashboardWorkspace() {
  const queryClient = useQueryClient()
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [taskDraft, setTaskDraft] = useState("")
  const [replyDraft, setReplyDraft] = useState("")
  const [showProjectForm, setShowProjectForm] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [projectName, setProjectName] = useState("")
  const [repoUrl, setRepoUrl] = useState("")
  const [cloneCredential, setCloneCredential] = useState("")
  const [githubToken, setGithubToken] = useState("")
  const [provider, setProvider] = useState("openai")
  const [model, setModel] = useState("gpt-4.1-mini")
  const [apiKey, setApiKey] = useState("")
  const [notice, setNotice] = useState("")

  const projectsQuery = useQuery({ queryKey: ["projects"], queryFn: fetchProjects })
  const projects = projectsQuery.data ?? []
  const project = projects.find((item) => item.id === selectedProjectId) ?? projects[0] ?? null

  useEffect(() => {
    if (project && project.id !== selectedProjectId) setSelectedProjectId(project.id)
    if (!project && selectedProjectId) setSelectedProjectId(null)
  }, [project, selectedProjectId])

  const tasksQuery = useQuery({
    queryKey: ["project-tasks", project?.id],
    queryFn: () => fetchProjectTasks(project!.id),
    enabled: Boolean(project),
    refetchInterval: (query) => query.state.data?.some((task) => activeStatuses.has(task.status)) ? 3_000 : false,
  })
  const tasks = tasksQuery.data ?? []
  const task = tasks.find((item) => item.id === selectedTaskId) ?? tasks[0] ?? null

  useEffect(() => {
    if (task && task.id !== selectedTaskId) setSelectedTaskId(task.id)
    if (!task && selectedTaskId) setSelectedTaskId(null)
  }, [task, selectedTaskId])

  const filesQuery = useQuery({
    queryKey: ["project-files", project?.id],
    queryFn: () => fetchProjectFiles(project!.id),
    enabled: Boolean(project && project.sandbox_status === "RUNNING"),
    refetchInterval: tasks.some((item) => activeStatuses.has(item.status)) ? 5_000 : false,
  })
  const files = filesQuery.data ?? []

  useEffect(() => {
    if (selectedFile && files.includes(selectedFile)) return
    setSelectedFile(files[0] ?? null)
  }, [files, selectedFile])

  const fileQuery = useQuery({
    queryKey: ["file-content", project?.id, selectedFile],
    queryFn: () => fetchFileContent(project!.id, selectedFile!),
    enabled: Boolean(project && selectedFile),
    refetchInterval: tasks.some((item) => activeStatuses.has(item.status)) ? 3_000 : false,
  })
  const settingsQuery = useQuery({ queryKey: ["settings"], queryFn: fetchSettings, enabled: showSettings })
  const usageQuery = useQuery({
    queryKey: ["task-usage", task?.id],
    queryFn: () => fetchTaskUsage(task!.id),
    enabled: Boolean(task),
    refetchInterval: task && activeStatuses.has(task.status) ? 5_000 : false,
  })
  const stream = useTaskStream(task?.id ?? null)

  useEffect(() => {
    if (!settingsQuery.data) return
    setProvider(settingsQuery.data.values.LLM_PROVIDER ?? "openai")
    setModel(settingsQuery.data.values.LLM_MODEL ?? "gpt-4.1-mini")
  }, [settingsQuery.data])

  const refreshProjectData = async (projectId?: string) => {
    await queryClient.invalidateQueries({ queryKey: ["projects"] })
    if (projectId) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project-tasks", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project-files", projectId] }),
      ])
    }
  }

  const projectMutation = useMutation({
    mutationFn: createProject,
    onSuccess: async (created) => {
      setShowProjectForm(false)
      setProjectName("")
      setRepoUrl("")
      setCloneCredential("")
      setGithubToken("")
      setSelectedProjectId(created.id)
      setNotice("Project created. Preparing its sandbox.")
      await queryClient.invalidateQueries({ queryKey: ["projects"] })
    },
    onError: (error) => setNotice(error.message),
  })
  const taskMutation = useMutation({
    mutationFn: ({ projectId, description }: { projectId: string; description: string }) => createTask(projectId, description),
    onSuccess: async (created, variables) => {
      setTaskDraft("")
      setSelectedTaskId(created.task.id)
      setNotice(created.queued ? `Task queued at position ${created.position}.` : "Task started.")
      await queryClient.invalidateQueries({ queryKey: ["project-tasks", variables.projectId] })
    },
    onError: (error) => setNotice(error.message),
  })
  const sandboxMutation = useMutation({
    mutationFn: ({ projectId, running }: { projectId: string; running: boolean }) => running ? destroySandbox(projectId) : startSandbox(projectId),
    onSuccess: async (updated) => {
      setNotice(updated.sandbox_status === "RUNNING" ? "Sandbox started." : "Sandbox destroyed.")
      await refreshProjectData(updated.id)
    },
    onError: (error) => setNotice(error.message),
  })
  const taskActionMutation = useMutation({
    mutationFn: ({ taskId, action }: { taskId: string; action: "cancel" | "resume" }) => action === "cancel" ? cancelTask(taskId) : resumeTask(taskId),
    onSuccess: async (_result, variables) => {
      setNotice(variables.action === "cancel" ? "Cancellation requested." : "Task resumed.")
      if (project) await queryClient.invalidateQueries({ queryKey: ["project-tasks", project.id] })
    },
    onError: (error) => setNotice(error.message),
  })
  const replyMutation = useMutation({
    mutationFn: ({ taskId, reply }: { taskId: string; reply: string }) => replyToTask(taskId, reply),
    onSuccess: () => {
      setReplyDraft("")
      setNotice("Reply sent.")
    },
    onError: (error) => setNotice(error.message),
  })
  const settingsMutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: async () => {
      setApiKey("")
      setNotice("Settings saved.")
      await queryClient.invalidateQueries({ queryKey: ["settings"] })
    },
    onError: (error) => setNotice(error.message),
  })

  function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input = {
      name: projectName.trim(),
      repo_url: repoUrl.trim(),
      ...(cloneCredential ? { clone_credential: cloneCredential } : {}),
      ...(githubToken ? { github_token: githubToken } : {}),
    }
    projectMutation.mutate(input)
  }

  function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (project && taskDraft.trim()) taskMutation.mutate({ projectId: project.id, description: taskDraft.trim() })
  }

  if (projectsQuery.isPending) {
    return <main className="grid min-h-screen place-items-center bg-zinc-100 text-sm text-zinc-600">Loading workspace...</main>
  }

  if (projectsQuery.isError) {
    return (
      <main className="grid min-h-screen place-items-center bg-zinc-100 p-6">
        <div className="max-w-md border border-rose-200 bg-white p-6">
          <h1 className="font-semibold text-zinc-900">Agent API unavailable</h1>
          <p className="mt-2 text-sm text-zinc-600">{projectsQuery.error.message}</p>
          <Button className="mt-4" onClick={() => void projectsQuery.refetch()}><RefreshCw className="mr-2 size-4" />Retry</Button>
        </div>
      </main>
    )
  }

  const isBusy = projectMutation.isPending || taskMutation.isPending || sandboxMutation.isPending
  const isTaskActive = task ? activeStatuses.has(task.status) : false
  const tokenCount = usageQuery.data?.total_tokens ?? 0

  return (
    <main className="min-h-screen bg-zinc-100 text-zinc-900 lg:h-screen lg:overflow-hidden">
      <div className="mx-auto flex min-h-screen max-w-[1900px] flex-col lg:h-screen lg:flex-row">
        <aside className="flex w-full shrink-0 flex-col border-b border-zinc-200 bg-white lg:w-64 lg:border-r lg:border-b-0">
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-4">
            <div>
              <p className="text-[10px] font-bold uppercase text-lime-700">Local coding agent</p>
              <h1 className="mt-1 text-lg font-semibold">CuteBots</h1>
            </div>
            <Button variant="outline" size="icon" title="Configure model" aria-label="Configure model" onClick={() => setShowSettings(true)}>
              <Settings className="size-4" />
            </Button>
          </div>
          <div className="flex items-center justify-between px-3 pt-4">
            <h2 className="text-xs font-semibold uppercase text-zinc-500">Projects</h2>
            <Button variant="ghost" size="icon" title="New project" aria-label="New project" onClick={() => setShowProjectForm(true)}>
              <Plus className="size-4" />
            </Button>
          </div>
          <nav className="flex gap-2 overflow-x-auto p-3 lg:flex-1 lg:flex-col lg:overflow-y-auto">
            {projects.map((item) => (
              <button key={item.id} type="button" onClick={() => setSelectedProjectId(item.id)}
                className={cn("min-w-44 border px-3 py-2 text-left lg:min-w-0", project?.id === item.id ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 bg-white hover:bg-zinc-50")}>
                <span className="block truncate text-sm font-medium">{item.name}</span>
                <span className={cn("mt-1 block truncate text-[11px]", project?.id === item.id ? "text-zinc-300" : "text-zinc-500")}>{item.repo_url}</span>
              </button>
            ))}
            {!projects.length && <p className="px-2 py-3 text-sm text-zinc-500">No projects yet.</p>}
          </nav>
          <div className="hidden border-t border-zinc-200 p-3 text-xs text-zinc-500 lg:block">Sandbox code is isolated in Docker.</div>
        </aside>

        {project ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold">{project.name}</h2>
                <p className="truncate text-xs text-zinc-500">{project.repo_url}</p>
              </div>
              <div className="flex items-center gap-2">
                <Status value={project.sandbox_status} />
                <Button variant="outline" size="sm" disabled={isBusy || (project.sandbox_status === "RUNNING" && tasks.some((item) => activeStatuses.has(item.status)))}
                  onClick={() => sandboxMutation.mutate({ projectId: project.id, running: project.sandbox_status === "RUNNING" })}>
                  {project.sandbox_status === "RUNNING" ? <><Square className="mr-2 size-3.5" />Destroy</> : <><Play className="mr-2 size-3.5" />Start</>}
                </Button>
              </div>
            </header>

            <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-zinc-200 lg:grid-cols-[230px_minmax(0,1fr)_minmax(280px,0.72fr)]">
              <Panel title="Files" action={<span className="text-[10px] text-zinc-400">{files.length}</span>} className="max-h-72 lg:max-h-none">
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {project.sandbox_status !== "RUNNING" && <p className="p-2 text-xs text-zinc-500">Start the sandbox to browse files.</p>}
                  {project.sandbox_status === "RUNNING" && filesQuery.isPending && <p className="p-2 text-xs text-zinc-500">Loading files...</p>}
                  {filesQuery.isError && <p className="p-2 text-xs text-rose-700">{filesQuery.error.message}</p>}
                  {files.map((file) => {
                    const name = file.replaceAll("\\", "/").split("/").at(-1) ?? file
                    return <button key={file} type="button" onClick={() => setSelectedFile(file)} className={cn("flex w-full items-center gap-2 truncate px-2 py-1.5 text-left font-mono text-xs", selectedFile === file ? "bg-lime-100 text-zinc-900" : "text-zinc-600 hover:bg-zinc-100")}><FileText className="size-3.5 shrink-0" />{name}</button>
                  })}
                  {!files.length && !filesQuery.isPending && <p className="p-2 text-xs text-zinc-500">No files in this workspace.</p>}
                </div>
              </Panel>

              <Panel title={selectedFile?.split(/[\\/]/).at(-1) ?? "File preview"} className="min-h-[340px]">
                {selectedFile ? <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-zinc-700">{fileQuery.isPending ? "Loading..." : fileQuery.isError ? fileQuery.error.message : fileQuery.data}</pre> : <div className="grid flex-1 place-items-center p-6 text-sm text-zinc-500">Choose a file to inspect it.</div>}
              </Panel>

              <div className="grid min-h-0 grid-rows-[minmax(240px,1fr)_minmax(260px,1fr)] gap-px bg-zinc-200">
                <Panel title="Agent activity" action={<span className="text-[10px] text-zinc-500">{stream.status}</span>}>
                  <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                    {stream.events.slice().reverse().map((event) => <article key={event.id} className="border-l-2 border-lime-500 bg-zinc-50 px-2.5 py-2"><p className="text-[10px] font-semibold uppercase text-zinc-500">{event.type}</p><p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-700">{event.content}</p></article>)}
                    {!stream.events.length && <p className="text-xs text-zinc-500">Select a task to view its live events.</p>}
                  </div>
                </Panel>

                <Panel title="Tasks" action={<span className="text-[10px] text-zinc-500">{tokenCount.toLocaleString()} tokens</span>}>
                  <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
                    {tasks.map((item: TaskSummary) => <button key={item.id} type="button" onClick={() => setSelectedTaskId(item.id)} className={cn("w-full border px-2.5 py-2 text-left", task?.id === item.id ? "border-zinc-900 bg-zinc-50" : "border-transparent hover:bg-zinc-50")}><span className="flex items-start justify-between gap-2"><span className="line-clamp-2 text-xs font-medium">{item.description}</span><Status value={item.status} /></span>{item.fail_reason && <span className="mt-1 block line-clamp-2 text-[10px] text-rose-700">{item.fail_reason}</span>}</button>)}
                    {!tasks.length && <p className="p-2 text-xs text-zinc-500">No tasks yet.</p>}
                  </div>
                  {task && (task.status === "RUNNING" || task.status === "PENDING") && <div className="flex gap-2 border-t border-zinc-200 p-2"><input aria-label="Reply to agent" value={replyDraft} onChange={(event) => setReplyDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && replyDraft.trim()) { event.preventDefault(); replyMutation.mutate({ taskId: task.id, reply: replyDraft.trim() }) } }} placeholder="Reply to a question..." className="h-9 min-w-0 flex-1 border border-zinc-300 px-2 text-xs outline-none focus:border-zinc-600" /><Button size="icon" title="Send reply" aria-label="Send reply" disabled={!replyDraft.trim() || replyMutation.isPending} onClick={() => replyMutation.mutate({ taskId: task.id, reply: replyDraft.trim() })}><Send className="size-4" /></Button></div>}
                  {task && <div className="flex gap-2 border-t border-zinc-200 p-2">{task.status === "PAUSED" && <Button variant="outline" size="sm" disabled={taskActionMutation.isPending} onClick={() => taskActionMutation.mutate({ taskId: task.id, action: "resume" })}><RotateCcw className="mr-2 size-3.5" />Resume</Button>}{activeStatuses.has(task.status) && <Button variant="outline" size="sm" disabled={taskActionMutation.isPending} onClick={() => taskActionMutation.mutate({ taskId: task.id, action: "cancel" })}><Ban className="mr-2 size-3.5" />Cancel task</Button>}</div>}
                  <form onSubmit={submitTask} className="border-t border-zinc-200 p-2">
                    <textarea aria-label="Task description" value={taskDraft} onChange={(event) => setTaskDraft(event.target.value)} placeholder="Describe work for the agent..." rows={2} className="w-full resize-y border border-zinc-300 p-2 text-xs outline-none focus:border-zinc-600" />
                    <Button type="submit" size="sm" className="mt-2 w-full" disabled={!taskDraft.trim() || project.sandbox_status !== "RUNNING" || taskMutation.isPending}><Plus className="mr-2 size-3.5" />{taskMutation.isPending ? "Starting..." : "Start task"}</Button>
                  </form>
                </Panel>
              </div>
            </div>

            {notice && <div role="status" className="flex items-center justify-between border-t border-zinc-200 bg-white px-4 py-2 text-xs text-zinc-700"><span>{notice}</span><button type="button" title="Dismiss" aria-label="Dismiss message" onClick={() => setNotice("")}><X className="size-3.5" /></button></div>}
          </div>
        ) : (
          <section className="grid min-h-[70vh] flex-1 place-items-center p-6">
            <div className="max-w-md text-center"><FolderGit2 className="mx-auto size-9 text-lime-700" /><h2 className="mt-4 text-xl font-semibold">Create your first project</h2><p className="mt-2 text-sm text-zinc-600">Connect a GitHub repository to create an isolated workspace and start delegating coding tasks.</p><Button className="mt-5" onClick={() => setShowProjectForm(true)}><Plus className="mr-2 size-4" />New project</Button></div>
          </section>
        )}
      </div>

      {showProjectForm && <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowProjectForm(false) }}><section role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" className="w-full max-w-lg border border-zinc-300 bg-white p-5 shadow-xl"><header className="flex items-center justify-between"><h2 id="project-dialog-title" className="text-lg font-semibold">New project</h2><Button variant="ghost" size="icon" title="Close" aria-label="Close" onClick={() => setShowProjectForm(false)}><X className="size-4" /></Button></header><form onSubmit={submitProject} className="mt-4 space-y-3"><label className="block text-xs font-medium">Project name<input required maxLength={120} value={projectName} onChange={(event) => setProjectName(event.target.value)} className="mt-1 h-10 w-full border border-zinc-300 px-3 text-sm" /></label><label className="block text-xs font-medium">GitHub repository URL<input required type="url" placeholder="https://github.com/owner/repository" value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} className="mt-1 h-10 w-full border border-zinc-300 px-3 text-sm" /></label><label className="block text-xs font-medium">Read-only clone credential <span className="font-normal text-zinc-500">(private repositories)</span><input type="password" autoComplete="off" value={cloneCredential} onChange={(event) => setCloneCredential(event.target.value)} className="mt-1 h-10 w-full border border-zinc-300 px-3 text-sm" /></label><label className="block text-xs font-medium">GitHub write token <span className="font-normal text-zinc-500">(push and pull requests)</span><input type="password" autoComplete="off" value={githubToken} onChange={(event) => setGithubToken(event.target.value)} className="mt-1 h-10 w-full border border-zinc-300 px-3 text-sm" /></label><div className="flex justify-end gap-2 pt-2"><Button type="button" variant="outline" onClick={() => setShowProjectForm(false)}>Cancel</Button><Button type="submit" disabled={projectMutation.isPending}>{projectMutation.isPending ? "Creating..." : "Create project"}</Button></div></form></section></div>}

      {showSettings && <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowSettings(false) }}><section role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title" className="w-full max-w-md border border-zinc-300 bg-white p-5 shadow-xl"><header className="flex items-center justify-between"><h2 id="settings-dialog-title" className="text-lg font-semibold">Model settings</h2><Button variant="ghost" size="icon" title="Close" aria-label="Close" onClick={() => setShowSettings(false)}><X className="size-4" /></Button></header><form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); settingsMutation.mutate({ LLM_PROVIDER: provider, LLM_MODEL: model, ...(apiKey.trim() ? { LLM_API_KEY: apiKey.trim() } : {}) }) }}><label className="block text-xs font-medium">Provider<select value={provider} onChange={(event) => setProvider(event.target.value)} className="mt-1 h-10 w-full border border-zinc-300 bg-white px-3 text-sm"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="groq">Groq</option><option value="ollama">Ollama</option></select></label><label className="block text-xs font-medium">Model<input required value={model} onChange={(event) => setModel(event.target.value)} className="mt-1 h-10 w-full border border-zinc-300 px-3 text-sm" /></label>{provider !== "ollama" && <label className="block text-xs font-medium">API key <span className="font-normal text-zinc-500">{settingsQuery.data?.configuredSecrets.LLM_API_KEY ? "(configured; leave blank to keep)" : "(not configured)"}</span><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} className="mt-1 h-10 w-full border border-zinc-300 px-3 text-sm" /></label>}<div className="flex justify-end gap-2 pt-2"><Button type="button" variant="outline" onClick={() => setShowSettings(false)}>Close</Button><Button type="submit" disabled={settingsMutation.isPending}>{settingsMutation.isPending ? "Saving..." : "Save settings"}</Button></div></form></section></div>}
    </main>
  )
}
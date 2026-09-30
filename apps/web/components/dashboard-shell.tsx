"use client"

import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { Button } from "@workspace/ui/components/button"
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card"
import { cn } from "@workspace/ui/lib/utils"
import { DashboardSkeleton } from "@/components/dashboard-skeleton"
import { useTaskStream } from "@/hooks/use-task-stream"
import { fetchProjectTasks, fetchProjects, fetchTaskUsage, type ProjectSummary, type TaskSummary } from "@/lib/agent-api"

function statusTone(status: string) {
  switch (status) {
    case "ACTIVE":
    case "RUNNING":
      return "bg-emerald-100 text-emerald-700 ring-emerald-200"
    case "PAUSED":
    case "PENDING":
      return "bg-amber-100 text-amber-700 ring-amber-200"
    default:
      return "bg-slate-200 text-slate-700 ring-slate-300"
  }
}

function formatProjectStatus(value: string): string {
  return value.toLowerCase().replace(/_/g, " ")
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "just now"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "just now"
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(date)
}

function StatusBadge({ label, tone }: { label: string; tone: string }) {
  return <span className={cn("inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1", tone)}>{label}</span>
}

function Panel({ title, description, children, className = "" }: { title: string; description?: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("shadow-sm", className)}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold text-slate-900">{title}</CardTitle>
        {description ? <p className="text-xs text-slate-500">{description}</p> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export function DashboardShell() {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [draftReply, setDraftReply] = useState("")

  const { data: projects = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ["projects"],
    queryFn: fetchProjects,
    staleTime: 30_000,
    retry: 1,
  })

  useEffect(() => {
    if (!projects.length) return

    const firstProject = projects[0]
    if (!firstProject) return

    if (!selectedProjectId || !projects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(firstProject.id)
    }
  }, [projects, selectedProjectId])

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null,
    [projects, selectedProjectId],
  )

  const { data: tasks = [], isLoading: tasksLoading } = useQuery({
    queryKey: ["project-tasks", selectedProject?.id ?? ""],
    queryFn: () => fetchProjectTasks(selectedProject!.id),
    enabled: Boolean(selectedProject),
    staleTime: 15_000,
    retry: 1,
  })

  const { data: taskUsage, isLoading: usageLoading } = useQuery({
    queryKey: ["task-usage", selectedTaskId],
    queryFn: () => fetchTaskUsage(selectedTaskId!),
    enabled: Boolean(selectedTaskId),
    staleTime: 30_000,
    retry: 1,
  })

  useEffect(() => {
    if (!tasks.length) {
      setSelectedTaskId(null)
      return
    }

    const firstTask = tasks[0]
    if (!firstTask) {
      setSelectedTaskId(null)
      return
    }

    if (!selectedTaskId || !tasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(firstTask.id)
    }
  }, [selectedTaskId, tasks])

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null,
    [selectedTaskId, tasks],
  )

  const stream = useTaskStream(selectedTask?.id ?? null)

  const recentStreamEvents = useMemo(() => {
    if (stream.events.length) return stream.events.slice(-6).reverse()
    if (!tasks.length) return []

    return tasks.slice(0, 5).map((task, index) => ({
      id: Number.parseInt(task.id.slice(-4), 16) || 1000 + index,
      taskId: task.id,
      type: task.status.toLowerCase(),
      content: task.description,
      created_at: task.updated_at,
    }))
  }, [stream.events, tasks])

  const taskSummary = useMemo(() => {
    const summary = {
      total: tasks.length,
      running: tasks.filter((task) => task.status === "RUNNING").length,
      pending: tasks.filter((task) => task.status === "PENDING").length,
      failed: tasks.filter((task) => task.status === "FAILED").length,
    }

    const totalTokens = taskUsage?.total_tokens ?? 0
    const estimatedCost = (totalTokens * 0.00001).toFixed(4)

    return [
      { label: "Tasks", value: String(summary.total) },
      { label: "Running", value: String(summary.running) },
      { label: "Tokens", value: totalTokens.toLocaleString() },
      { label: "Est. cost", value: `$${estimatedCost}` },
    ]
  }, [taskUsage, tasks])

  if (isLoading || tasksLoading || usageLoading) {
    return <DashboardSkeleton />
  }

  if (isError || !selectedProject) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6 text-slate-700">
        <Card className="max-w-md shadow-sm">
          <CardHeader>
            <CardTitle>Project data unavailable</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-slate-600">
              {error instanceof Error ? error.message : "Unable to load the workspace dashboard right now."}
            </p>
            <Button type="button" onClick={() => void refetch()} className="w-full">
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const projectPanels: Array<{
    name: string
    kind: "folder" | "file"
    path?: string
    children?: Array<{ name: string; path: string; kind: "folder" | "file" }>
  }> = [
    {
      name: "app",
      kind: "folder",
      children: [
        { name: "layout.tsx", path: "app/layout.tsx", kind: "file" },
        { name: "page.tsx", path: "app/page.tsx", kind: "file" },
        { name: "globals.css", path: "app/globals.css", kind: "file" },
      ],
    },
    {
      name: "components",
      kind: "folder",
      children: [
        { name: "dashboard-shell.tsx", path: "components/dashboard-shell.tsx", kind: "file" },
        { name: "query-provider.tsx", path: "components/query-provider.tsx", kind: "file" },
      ],
    },
    { name: "package.json", path: "package.json", kind: "file" },
    { name: "tsconfig.json", path: "tsconfig.json", kind: "file" },
  ]

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="mx-auto flex h-screen max-w-[1800px] gap-4 p-4">
        <aside className="flex w-[290px] flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-4 py-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Workspace</p>
                <h1 className="mt-1 text-lg font-semibold text-slate-900">Cutebots</h1>
              </div>
              <Button variant="outline" size="sm" className="h-8 rounded-xl">
                + New
              </Button>
            </div>
          </div>

          <div className="flex-1 space-y-2 px-3 py-3">
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => setSelectedProjectId(project.id)}
                className={cn(
                  "flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left transition-colors",
                  selectedProjectId === project.id
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100",
                )}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{project.name}</div>
                  <div className={cn("mt-1 text-[11px]", selectedProjectId === project.id ? "text-slate-300" : "text-slate-500")}>
                    {new Date(project.created_at).toLocaleDateString()}
                  </div>
                </div>
                <span
                  className={cn(
                    "inline-flex rounded-full px-2 py-1 text-[10px] font-medium ring-1",
                    selectedProjectId === project.id ? "bg-white/10 text-white ring-white/20" : statusTone(project.status),
                  )}
                >
                  {formatProjectStatus(project.status)}
                </span>
              </button>
            ))}
          </div>

          <div className="border-t border-slate-200 p-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Repo</p>
              <p className="mt-2 truncate text-sm font-medium text-slate-800">{selectedProject.repo_url}</p>
            </div>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-4">
          <header className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <div>
              <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Selected project</p>
              <h2 className="mt-1 text-xl font-semibold text-slate-900">{selectedProject.name}</h2>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge label={formatProjectStatus(selectedProject.status)} tone={statusTone(selectedProject.status)} />
              <Button variant="secondary" className="rounded-xl">
                Start sandbox
              </Button>
            </div>
          </header>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.8fr)]">
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {taskSummary.map((item) => (
                  <Card key={item.label} className="shadow-sm">
                    <CardContent className="p-4">
                      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{item.label}</p>
                      <p className="mt-3 text-2xl font-semibold text-slate-900">{item.value}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>

              <Panel title="File tree" description={`${selectedProject.sandbox_type} • ${selectedProject.sandbox_status}`}>
                <div className="space-y-1">
                  {projectPanels.map((node) => (
                    <div key={node.path ?? node.name} className="rounded-xl border border-slate-200 bg-slate-50 p-2">
                      <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
                        <span className="text-slate-500">{node.kind === "folder" ? "▾" : "▸"}</span>
                        {node.name}
                      </div>
                      {node.children ? (
                        <div className="mt-2 space-y-1 pl-6">
                          {node.children.map((child) => (
                            <div key={child.path} className="flex items-center gap-2 text-sm text-slate-600">
                              <span className="text-slate-400">{child.name.includes(".") ? "•" : "▾"}</span>
                              {child.name}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </Panel>
            </div>

            <Panel title="Agent stream" description={stream.status === "connected" ? "Live task events" : "Waiting for task events"}>
              <div className="space-y-3">
                {recentStreamEvents.length ? (
                  recentStreamEvents.map((entry) => (
                    <div key={`${entry.taskId}-${entry.id}`} className="rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">{entry.type}</span>
                        <span className="text-[11px] text-slate-400">{formatTime(entry.created_at)}</span>
                      </div>
                      <p className="mt-2 text-sm text-slate-700">{entry.content}</p>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-500">No task events yet for this project.</p>
                )}
              </div>
            </Panel>
          </div>

          <div className="grid flex-1 gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
            <Panel title="Workspace preview" description="Current working copy" className="min-h-[280px]">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-6 text-slate-700">
                <div className="mb-3 flex items-center justify-between border-b border-slate-200 pb-2">
                  <span className="font-semibold text-slate-800">repo/{selectedProject.name}</span>
                  <span className="text-slate-500">{selectedProject.sandbox_type}</span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap">{`export default function Page() {
  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <DashboardShell />
    </main>
  )
}`}</pre>
              </div>
            </Panel>

            <Panel title="Task queue" description={selectedTask ? `Selected task: ${selectedTask.status}` : "No active task"}>
              <div className="space-y-3">
                {tasks.length ? (
                  tasks.slice(0, 6).map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => setSelectedTaskId(task.id)}
                      className={cn(
                        "w-full rounded-xl border p-3 text-left transition-colors",
                        selectedTaskId === task.id ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-slate-50 text-slate-700",
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium">{task.description}</span>
                        <StatusBadge label={task.status} tone={selectedTaskId === task.id ? "bg-white/10 text-white ring-white/20" : statusTone(task.status)} />
                      </div>
                      <p className={cn("mt-2 text-[11px]", selectedTaskId === task.id ? "text-slate-300" : "text-slate-500")}>
                        {formatTime(task.updated_at)}
                      </p>
                    </button>
                  ))
                ) : (
                  <p className="text-sm text-slate-500">No tasks for this workspace yet.</p>
                )}
              </div>

              <div className="mt-4 flex gap-2">
                <input
                  aria-label="Reply to agent"
                  value={draftReply}
                  onChange={(event) => setDraftReply(event.target.value)}
                  placeholder="Send a follow-up…"
                  className="h-10 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-800 outline-none ring-0 placeholder:text-slate-400 focus:border-slate-400"
                />
                <Button type="button" className="h-10 rounded-xl" onClick={() => setDraftReply("")} disabled={!draftReply.trim()}>
                  Send
                </Button>
              </div>
            </Panel>
          </div>
        </main>
      </div>
    </div>
  )
}

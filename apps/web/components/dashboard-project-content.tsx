"use client"

import { memo, useEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { Ban, FileText, Play, Plus, RefreshCw, RotateCcw, Send, Square } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import { cn } from "@workspace/ui/lib/utils"
import { DashboardPanel, DashboardStatus } from "@/components/dashboard-primitives"
import { useDashboardFiles, useDashboardTasks, useDashboardWorkspace } from "@/contexts/dashboard-context"
import { activeTaskStatuses } from "@/lib/dashboard"

type PanelId = "files" | "preview" | "activity" | "tasks"

interface WorkspaceLayout {
  filesShare: number
  previewShare: number
  activityShare: number
  collapsed: Record<PanelId, boolean>
}

type ResizeDrag =
  | { axis: "horizontal"; start: number; leftColumn: "files" | "preview"; rightColumn: "preview" | "right"; filesShare: number; previewShare: number }
  | { axis: "vertical"; start: number; activityShare: number }

const LAYOUT_STORAGE_KEY = "cutebots.workspace-layout.v1"
const defaultWorkspaceLayout: WorkspaceLayout = {
  filesShare: 20,
  previewShare: 48,
  activityShare: 50,
  collapsed: { files: false, preview: false, activity: false, tasks: false },
}
const panelLabels: Record<PanelId, string> = {
  files: "Files",
  preview: "Preview",
  activity: "Agent activity",
  tasks: "Tasks",
}
const panelIds: PanelId[] = ["files", "preview", "activity", "tasks"]

export const DashboardProjectContent = memo(function DashboardProjectContent() {
  const {
    project,
    onSandboxToggle,
    sandboxPending,
    onRetrySetup,
    setupRetryPending,
    onSwitchToNodeSandbox,
    switchSandboxPending,
  } = useDashboardWorkspace()
  const {
    tasks,
    tasksLoading,
    selectedTaskId,
    onSelectTask,
    stream,
    tokenCount,
    onCreateTask,
    onTaskAction,
    onReply,
    taskPending,
    taskActionPending,
    replyPending,
  } = useDashboardTasks()
  const {
    files,
    filesLoading,
    filesError,
    selectedFile,
    onSelectFile,
    fileContent,
    fileLoading,
    fileError,
  } = useDashboardFiles()
  const [taskDraft, setTaskDraft] = useState("")
  const [replyDraft, setReplyDraft] = useState("")
  const [layout, setLayout] = useState<WorkspaceLayout>(defaultWorkspaceLayout)
  const [layoutLoaded, setLayoutLoaded] = useState(false)
  const [layoutWarning, setLayoutWarning] = useState("")
  const gridRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<ResizeDrag | null>(null)
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(LAYOUT_STORAGE_KEY)
      if (stored) setLayout(parseWorkspaceLayout(JSON.parse(stored)))
    } catch {
      setLayoutWarning("Saved workspace layout could not be read; using the default layout.")
    } finally {
      setLayoutLoaded(true)
    }
  }, [])

  useEffect(() => {
    if (!layoutLoaded) return
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout))
      setLayoutWarning("")
    } catch {
      setLayoutWarning("Workspace layout could not be saved in this browser.")
    }
  }, [layout, layoutLoaded])

  if (!project) return null

  const task = tasks.find((item) => item.id === selectedTaskId) ?? tasks[0] ?? null
  const hasActiveTasks = tasks.some((item) => activeTaskStatuses.has(item.status))
  const isSandboxRunning = project.sandbox_status === "RUNNING"
  const setupReady = project.setup_status === "READY"
  const visiblePanels = panelIds.filter((id) => !layout.collapsed[id])
  const desktopColumns = (["files", "preview", "right"] as const).filter((column) => {
    if (column === "files") return visiblePanels.includes("files")
    if (column === "preview") return visiblePanels.includes("preview")
    return visiblePanels.includes("activity") || visiblePanels.includes("tasks")
  })
  const firstHandleVisible = desktopColumns.length > 1 && desktopColumns[0] === "files"
  const secondHandleVisible = desktopColumns.length > 1 &&
    desktopColumns[desktopColumns.length - 2] === "preview" &&
    desktopColumns[desktopColumns.length - 1] === "right"
  const horizontalHandleCount = Number(firstHandleVisible) + Number(secondHandleVisible)
  const availableWidth = Math.max(1, (gridRef.current?.scrollWidth ?? 1000) - horizontalHandleCount * 6)
  const activityVisible = visiblePanels.includes("activity")
  const tasksVisible = visiblePanels.includes("tasks")

  function panelWrapperClass(id: PanelId) {
    return cn(
      "min-h-0 min-w-0 flex-col",
      layout.collapsed[id] ? "hidden" : "flex",
    )
  }

  function toggleCollapse(id: PanelId) {
    const willCollapse = !layoutRef.current.collapsed[id]
    setLayout((current) => ({
      ...current,
      collapsed: { ...current.collapsed, [id]: !current.collapsed[id] },
    }))
    if (willCollapse) {
      requestAnimationFrame(() => {
        document.getElementById(`restore-panel-${id}`)?.focus()
      })
    }
  }

  function beginHorizontalResize(event: ReactPointerEvent<HTMLDivElement>, divider: "first" | "second") {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const leftIndex = divider === "first" || desktopColumns.length === 2 ? 0 : 1
    const leftColumn = desktopColumns[leftIndex]
    const rightColumn = desktopColumns[leftIndex + 1]
    if ((leftColumn !== "files" && leftColumn !== "preview") ||
      (rightColumn !== "preview" && rightColumn !== "right")) return
    dragRef.current = {
      axis: "horizontal",
      start: event.clientX,
      leftColumn,
      rightColumn,
      filesShare: layoutRef.current.filesShare,
      previewShare: layoutRef.current.previewShare,
    }
  }

  function moveHorizontalResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.axis !== "horizontal") return
    const delta = (event.clientX - drag.start) / availableWidth * 100
    const current = layoutRef.current
    const rightShare = 100 - drag.filesShare - drag.previewShare
    let filesShare = drag.filesShare
    let previewShare = drag.previewShare

    if (drag.leftColumn === "files" && drag.rightColumn === "preview") {
      filesShare = clamp(drag.filesShare + delta, 14, Math.min(38, drag.filesShare + drag.previewShare - 24))
      previewShare = drag.filesShare + drag.previewShare - filesShare
    } else if (drag.leftColumn === "preview" && drag.rightColumn === "right") {
      previewShare = clamp(drag.previewShare + delta, 24, Math.min(64, drag.previewShare + rightShare - 20))
    } else if (drag.leftColumn === "files" && drag.rightColumn === "right") {
      filesShare = clamp(drag.filesShare + delta, 14, Math.min(38, drag.filesShare + rightShare - 24))
    }

    setLayout({ ...current, filesShare, previewShare })
  }

  function beginVerticalResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      axis: "vertical",
      start: event.clientY,
      activityShare: layoutRef.current.activityShare,
    }
  }

  function moveVerticalResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.axis !== "vertical") return
    const height = Math.max(1, event.currentTarget.parentElement?.getBoundingClientRect().height ?? 1)
    const delta = (event.clientY - drag.start) / height * 100
    setLayout({ ...layoutRef.current, activityShare: clamp(drag.activityShare + delta, 25, 75) })
  }

  function resizeWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>, axis: "horizontal" | "vertical", divider: "first" | "second" = "first") {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return
    event.preventDefault()
    const current = layoutRef.current
    if (axis === "vertical") {
      const delta = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -3 : 3
      setLayout({ ...current, activityShare: clamp(current.activityShare + delta, 25, 75) })
      return
    }
    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -3 : 3
    const leftIndex = divider === "first" || desktopColumns.length === 2 ? 0 : 1
    const first = desktopColumns[leftIndex]
    const second = desktopColumns[leftIndex + 1]
    if (first === "files" && second === "preview") {
      const filesShare = clamp(current.filesShare + delta, 14, 38)
      setLayout({ ...current, filesShare, previewShare: current.filesShare + current.previewShare - filesShare })
    } else if (first === "preview" && second === "right") {
      setLayout({ ...current, previewShare: clamp(current.previewShare + delta, 24, 64) })
    } else if (first === "files" && second === "right") {
      setLayout({ ...current, filesShare: clamp(current.filesShare + delta, 14, 38) })
    }
  }

  function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!taskDraft.trim() || taskPending) return
    onCreateTask(taskDraft.trim(), () => setTaskDraft(""))
  }

  function submitReply() {
    if (!task || !replyDraft.trim() || replyPending) return
    onReply(replyDraft.trim(), () => setReplyDraft(""))
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{project.name}</h2>
          <p className="truncate text-xs text-zinc-500">{project.repo_url}</p>
          <p className="mt-1 text-[10px] text-zinc-500">
            {project.sandbox_type === "minimal" ? "No Node.js sandbox" : "Node.js sandbox"}
            {setupReady && project.detected_setup ? ` · ${project.detected_setup}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DashboardStatus value={project.sandbox_status} />
          <DashboardStatus value={project.setup_status} />
          <Button
            variant="outline"
            size="sm"
            disabled={sandboxPending || project.setup_status === "PROVISIONING" || (isSandboxRunning && hasActiveTasks)}
            onClick={onSandboxToggle}
          >
            {isSandboxRunning ? (
              <>
                <Square className="mr-2 size-3.5" />
                Destroy
              </>
            ) : (
              <>
                <Play className="mr-2 size-3.5" />
                Start
              </>
            )}
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setLayout(defaultWorkspaceLayout)}>Reset layout</Button>
        {layoutWarning && <span role="status" className="text-[10px] text-amber-700">{layoutWarning}</span>}
        <div className="ml-auto flex flex-wrap gap-1">
          {panelIds.filter((id) => layout.collapsed[id]).map((id) => (
            <Button
              key={id}
              id={`restore-panel-${id}`}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLayout((current) => ({
                ...current,
                collapsed: { ...current.collapsed, [id]: false },
              }))}
            >
              Restore {panelLabels[id]}
            </Button>
          ))}
        </div>
      </div>
      {project.setup_status !== "READY" && (
        <section
          role="status"
          className={cn(
            "border-b px-4 py-3",
            project.setup_status === "FAILED"
              ? "border-rose-200 bg-rose-50"
              : "border-amber-200 bg-amber-50",
          )}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {project.setup_status === "FAILED" ? "Project setup failed" : "Preparing project environment"}
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                {project.setup_error ??
                  "Repository is being cloned and its initial requirements are being prepared. Tasks are enabled after setup succeeds."}
              </p>
            </div>
            {project.setup_status === "FAILED" && (
              <div className="flex flex-wrap gap-2">
                {project.sandbox_type === "minimal" && project.setup_error?.includes("needs Node.js") && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={switchSandboxPending}
                    onClick={onSwitchToNodeSandbox}
                  >
                    <RefreshCw className="mr-2 size-3.5" />
                    {switchSandboxPending ? "Switching..." : "Switch to Node.js sandbox"}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={setupRetryPending || !isSandboxRunning}
                  onClick={onRetrySetup}
                >
                  <RefreshCw className="mr-2 size-3.5" />
                  {setupRetryPending ? "Retrying..." : "Retry setup"}
                </Button>
              </div>
            )}
          </div>
          {project.setup_log && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-zinc-600">Setup log</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-zinc-200 bg-white p-2 font-mono text-[10px] leading-4 text-zinc-700">
                {project.setup_log.slice(-12_000)}
              </pre>
            </details>
          )}
        </section>
      )}

      <div
        ref={gridRef}
        className="grid min-h-0 min-w-[900px] flex-1 gap-px overflow-auto bg-zinc-200 [grid-template-columns:var(--workspace-grid)]"
        style={{
          "--workspace-grid": `${layout.collapsed.files ? "0fr" : `${layout.filesShare}fr`} ${firstHandleVisible ? "6px" : "0px"} ${layout.collapsed.preview ? "0fr" : `${layout.previewShare}fr`} ${secondHandleVisible ? "6px" : "0px"} ${activityVisible || tasksVisible ? `${Math.max(1, 100 - layout.filesShare - layout.previewShare)}fr` : "0fr"}`,
          "--activity-share": `${layout.activityShare}fr`,
          "--tasks-share": `${100 - layout.activityShare}fr`,
        } as CSSProperties}
      >
        <div className={panelWrapperClass("files")}>
        <DashboardPanel
          title="Files"
          action={<span className="text-[10px] text-zinc-400">{files.length}</span>}
          className="max-h-72 lg:max-h-none"
          collapsed={layout.collapsed.files}
          onToggleCollapse={() => toggleCollapse("files")}
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {!isSandboxRunning && <p className="p-2 text-xs text-zinc-500">Start the sandbox to browse files.</p>}
            {isSandboxRunning && !setupReady && <p className="p-2 text-xs text-zinc-500">Files are available after setup completes.</p>}
            {isSandboxRunning && setupReady && filesLoading && <p className="p-2 text-xs text-zinc-500">Loading files...</p>}
            {filesError && <p className="p-2 text-xs text-rose-700">{filesError}</p>}
            {files.map((file) => {
              const name = file.replaceAll("\\", "/").split("/").at(-1) ?? file

              return (
                <Button
                  key={file}
                  type="button"
                  variant="ghost"
                  size="default"
                  onClick={() => onSelectFile(file)}
                  className={cn(
                    "h-auto w-full justify-start gap-2 rounded-none px-2 py-1.5 text-left font-mono text-xs font-normal",
                    selectedFile === file ? "bg-lime-100 text-zinc-900" : "text-zinc-600 hover:bg-zinc-100",
                  )}
                >
                  <FileText className="size-3.5 shrink-0" />
                  {name}
                </Button>
              )
            })}
            {!files.length && !filesLoading && <p className="p-2 text-xs text-zinc-500">No files in this workspace.</p>}
          </div>
        </DashboardPanel>
        </div>

        <div
          role="separator"
          aria-label={`Resize ${panelLabels[desktopColumns[0] === "files" ? "files" : "preview"]} and ${panelLabels[desktopColumns[1] === "right" ? (activityVisible ? "activity" : "tasks") : "preview"]} panels`}
          aria-orientation="vertical"
          aria-valuenow={Math.round(layout.filesShare)}
          aria-valuemin={14}
          aria-valuemax={38}
          tabIndex={0}
          onPointerDown={(event) => beginHorizontalResize(event, "first")}
          onPointerMove={moveHorizontalResize}
          onPointerUp={() => { dragRef.current = null }}
          onPointerCancel={() => { dragRef.current = null }}
          onKeyDown={(event) => resizeWithKeyboard(event, "horizontal", "first")}
          className={cn(
            "flex cursor-col-resize touch-none items-center justify-center bg-zinc-200 hover:bg-lime-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-zinc-800",
            firstHandleVisible ? "" : "invisible",
          )}
        >
          <span className="h-8 w-0.5 rounded bg-zinc-500" />
        </div>

        <div className={panelWrapperClass("preview")}>
        <DashboardPanel
          title={selectedFile?.split(/[\\/]/).at(-1) ?? "File preview"}
          className="min-h-[340px] lg:min-h-0"
          collapsed={layout.collapsed.preview}
          onToggleCollapse={() => toggleCollapse("preview")}
        >
          {selectedFile ? (
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-zinc-700">
              {fileLoading ? "Loading..." : fileError ?? fileContent}
            </pre>
          ) : (
            <div className="grid flex-1 place-items-center p-6 text-sm text-zinc-500">
              Choose a file to inspect it.
            </div>
          )}
        </DashboardPanel>
        </div>

        <div
          role="separator"
          aria-label={`Resize ${panelLabels[desktopColumns[desktopColumns.length - 2] === "files" ? "files" : "preview"]} and ${panelLabels[activityVisible ? "activity" : "tasks"]} panels`}
          aria-orientation="vertical"
          aria-valuenow={Math.round(layout.previewShare)}
          aria-valuemin={24}
          aria-valuemax={64}
          tabIndex={0}
          onPointerDown={(event) => beginHorizontalResize(event, "second")}
          onPointerMove={moveHorizontalResize}
          onPointerUp={() => { dragRef.current = null }}
          onPointerCancel={() => { dragRef.current = null }}
          onKeyDown={(event) => resizeWithKeyboard(event, "horizontal", "second")}
          className={cn(
            "flex cursor-col-resize touch-none items-center justify-center bg-zinc-200 hover:bg-lime-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-zinc-800",
            secondHandleVisible ? "" : "invisible",
          )}
        >
          <span className="h-8 w-0.5 rounded bg-zinc-500" />
        </div>

        <div className={cn(
          "grid min-h-0 min-w-0 gap-px bg-zinc-200",
          activityVisible || tasksVisible ? "grid" : "hidden",
        )} style={{ gridTemplateRows: activityVisible && tasksVisible ? "minmax(0, var(--activity-share)) 6px minmax(0, var(--tasks-share))" : "minmax(0, 1fr)" }}>
          <div className={panelWrapperClass("activity")}>
          <DashboardPanel
            title="Agent activity"
            action={<span className="text-[10px] text-zinc-500">{stream.status}</span>}
            collapsed={layout.collapsed.activity}
            onToggleCollapse={() => toggleCollapse("activity")}
          >
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {stream.events.slice().reverse().map((event) => (
                <article key={event.id} className="border-l-2 border-lime-500 bg-zinc-50 px-2.5 py-2">
                  <p className="text-[10px] font-semibold uppercase text-zinc-500">{event.type}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-700">
                    {formatActivityContent(event.type, event.content)}
                  </p>
                </article>
              ))}
              {!stream.events.length && <p className="text-xs text-zinc-500">Select a task to view its live events.</p>}
            </div>
          </DashboardPanel>
          </div>

          {activityVisible && tasksVisible && (
            <div
              role="separator"
              aria-label="Resize Agent activity and Tasks panels"
              aria-orientation="horizontal"
              aria-valuenow={Math.round(layout.activityShare)}
              aria-valuemin={25}
              aria-valuemax={75}
              tabIndex={0}
              onPointerDown={beginVerticalResize}
              onPointerMove={moveVerticalResize}
              onPointerUp={() => { dragRef.current = null }}
              onPointerCancel={() => { dragRef.current = null }}
              onKeyDown={(event) => resizeWithKeyboard(event, "vertical")}
              className="flex cursor-row-resize touch-none items-center justify-center bg-zinc-200 hover:bg-lime-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-zinc-800"
            >
              <span className="h-0.5 w-8 rounded bg-zinc-500" />
            </div>
          )}

          <div className={panelWrapperClass("tasks")}>
          <DashboardPanel
            title="Tasks"
            action={<span className="text-[10px] text-zinc-500">{new Intl.NumberFormat("en-US").format(tokenCount)} tokens</span>}
            collapsed={layout.collapsed.tasks}
            onToggleCollapse={() => toggleCollapse("tasks")}
          >
            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
              {tasks.map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  variant="ghost"
                  size="default"
                  onClick={() => onSelectTask(item.id)}
                  className={cn(
                    "h-auto w-full justify-start rounded-none border px-2.5 py-2 text-left whitespace-normal",
                    task?.id === item.id ? "border-zinc-900 bg-zinc-50" : "border-transparent hover:bg-zinc-50",
                  )}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="line-clamp-2 text-xs font-medium">{item.description}</span>
                    <DashboardStatus value={item.status} />
                  </span>
                  {item.fail_reason && (
                    <span
                      className={cn(
                        "mt-1 block line-clamp-2 text-[10px]",
                        item.status === "UNVERIFIED" ? "text-orange-700" : "text-rose-700",
                      )}
                    >
                      {item.fail_reason}
                    </span>
                  )}
                </Button>
              ))}
              {!tasks.length && !tasksLoading && <p className="p-2 text-xs text-zinc-500">No tasks yet.</p>}
              {tasksLoading && <p className="p-2 text-xs text-zinc-500">Loading tasks...</p>}
            </div>

            {task && activeTaskStatuses.has(task.status) && (
              <div className="flex gap-2 border-t border-zinc-200 p-2">
                <Input
                  aria-label="Reply to agent"
                  value={replyDraft}
                  onChange={(event) => setReplyDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault()
                      submitReply()
                    }
                  }}
                  placeholder="Reply to a question..."
                  className="h-9 min-w-0 flex-1 rounded-none border-zinc-300 px-2 text-xs shadow-none focus-visible:border-zinc-600 focus-visible:ring-0"
                />
                <Button
                  size="icon"
                  title="Send reply"
                  aria-label="Send reply"
                  disabled={!replyDraft.trim() || replyPending}
                  onClick={submitReply}
                >
                  <Send className="size-4" />
                </Button>
              </div>
            )}

            {task && (
              <div className="flex gap-2 border-t border-zinc-200 p-2">
                {task.status === "PAUSED" && (
                  <Button variant="outline" size="sm" disabled={taskActionPending} onClick={() => onTaskAction("resume")}>
                    <RotateCcw className="mr-2 size-3.5" />
                    Resume
                  </Button>
                )}
                {activeTaskStatuses.has(task.status) && (
                  <Button variant="outline" size="sm" disabled={taskActionPending} onClick={() => onTaskAction("cancel")}>
                    <Ban className="mr-2 size-3.5" />
                    Cancel task
                  </Button>
                )}
              </div>
            )}

            <form onSubmit={submitTask} className="border-t border-zinc-200 p-2">
              <Textarea
                aria-label="Task description"
                value={taskDraft}
                onChange={(event) => setTaskDraft(event.target.value)}
                placeholder="Describe work for the agent..."
                rows={2}
                className="min-h-0 resize-y rounded-none border-zinc-300 p-2 text-xs shadow-none focus-visible:border-zinc-600 focus-visible:ring-0"
              />
              <Button
                type="submit"
                size="sm"
                className="mt-2 w-full"
                disabled={!taskDraft.trim() || !isSandboxRunning || !setupReady || taskPending}
              >
                <Plus className="mr-2 size-3.5" />
                {taskPending ? "Starting..." : !setupReady ? "Setup required" : "Start task"}
              </Button>
            </form>
          </DashboardPanel>
          </div>
        </div>
      </div>
    </div>
  )
})

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function parseWorkspaceLayout(value: unknown): WorkspaceLayout {
  if (typeof value !== "object" || value === null) return { ...defaultWorkspaceLayout }
  const stored = value as Partial<WorkspaceLayout>
  const collapsed = typeof stored.collapsed === "object" && stored.collapsed !== null
    ? stored.collapsed
    : defaultWorkspaceLayout.collapsed
  return {
    filesShare: clamp(typeof stored.filesShare === "number" ? stored.filesShare : defaultWorkspaceLayout.filesShare, 14, 38),
    previewShare: clamp(typeof stored.previewShare === "number" ? stored.previewShare : defaultWorkspaceLayout.previewShare, 24, 64),
    activityShare: clamp(typeof stored.activityShare === "number" ? stored.activityShare : defaultWorkspaceLayout.activityShare, 25, 75),
    collapsed: {
      files: collapsed.files === true,
      preview: collapsed.preview === true,
      activity: collapsed.activity === true,
      tasks: collapsed.tasks === true,
    },
  }
}

function formatActivityContent(type: string, content: string): string {
  if (type !== "plan" && type !== "evidence" && type !== "tool_failure") return content
  try {
    const parsed: unknown = JSON.parse(content)
    if (typeof parsed !== "object" || parsed === null) return content
    const record = parsed as Record<string, unknown>
    if (type === "plan") {
      const steps = Array.isArray(record.steps) ? record.steps : []
      return [
        typeof record.title === "string" ? `Plan: ${record.title}` : "Plan update",
        ...steps.map((step, index) => {
          if (typeof step !== "object" || step === null) return `${index + 1}. [unknown]`
          const item = step as Record<string, unknown>
          return `${index + 1}. [${String(item.status ?? "pending")}] ${String(item.description ?? "")}`
        }),
      ].join("\n")
    }
    if (type === "tool_failure") {
      return `${String(record.tool ?? "Tool")} failed: ${String(record.message ?? "No error details")}`
    }
    const usage = typeof record.usage === "object" && record.usage !== null
      ? record.usage as Record<string, unknown>
      : {}
    const verification = typeof record.verification === "object" && record.verification !== null
      ? record.verification as Record<string, unknown>
      : {}
    const changedFiles = Array.isArray(record.changedFiles) ? record.changedFiles : []
    return [
      `Final report saved (${String(record.schemaVersion ?? "unknown")})`,
      `Status: ${String(record.status ?? "unknown")}; verification: ${String(verification.status ?? "unknown")}`,
      `Changed files: ${changedFiles.map((file) => typeof file === "object" && file !== null ? String((file as Record<string, unknown>).path ?? "") : "").filter(Boolean).join(", ") || "none"}`,
      `Usage: ${usage.totalTokens === null || usage.totalTokens === undefined
        ? "unavailable"
        : `${String(usage.inputTokens)} input + ${String(usage.outputTokens)} output tokens`}`,
    ].join("\n")
  } catch {
    return content
  }
}

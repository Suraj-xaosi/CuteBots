"use client"

import { memo, useState, type FormEvent } from "react"
import { Ban, FileText, Play, Plus, RotateCcw, Send, Square } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import { cn } from "@workspace/ui/lib/utils"
import { DashboardPanel, DashboardStatus } from "@/components/dashboard-primitives"
import { useDashboardFiles, useDashboardTasks, useDashboardWorkspace } from "@/contexts/dashboard-context"
import { activeTaskStatuses } from "@/lib/dashboard"

export const DashboardProjectContent = memo(function DashboardProjectContent() {
  const { project, onSandboxToggle, sandboxPending } = useDashboardWorkspace()
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
  if (!project) return null

  const task = tasks.find((item) => item.id === selectedTaskId) ?? tasks[0] ?? null
  const hasActiveTasks = tasks.some((item) => activeTaskStatuses.has(item.status))
  const isSandboxRunning = project.sandbox_status === "RUNNING"

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
        </div>
        <div className="flex items-center gap-2">
          <DashboardStatus value={project.sandbox_status} />
          <Button
            variant="outline"
            size="sm"
            disabled={sandboxPending || (isSandboxRunning && hasActiveTasks)}
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

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-zinc-200 lg:grid-cols-[230px_minmax(0,1fr)_minmax(280px,0.72fr)]">
        <DashboardPanel
          title="Files"
          action={<span className="text-[10px] text-zinc-400">{files.length}</span>}
          className="max-h-72 lg:max-h-none"
        >
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {!isSandboxRunning && <p className="p-2 text-xs text-zinc-500">Start the sandbox to browse files.</p>}
            {isSandboxRunning && filesLoading && <p className="p-2 text-xs text-zinc-500">Loading files...</p>}
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

        <DashboardPanel title={selectedFile?.split(/[\\/]/).at(-1) ?? "File preview"} className="min-h-[340px]">
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

        <div className="grid min-h-0 grid-rows-[minmax(240px,1fr)_minmax(260px,1fr)] gap-px bg-zinc-200">
          <DashboardPanel title="Agent activity" action={<span className="text-[10px] text-zinc-500">{stream.status}</span>}>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {stream.events.slice().reverse().map((event) => (
                <article key={event.id} className="border-l-2 border-lime-500 bg-zinc-50 px-2.5 py-2">
                  <p className="text-[10px] font-semibold uppercase text-zinc-500">{event.type}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-700">{event.content}</p>
                </article>
              ))}
              {!stream.events.length && <p className="text-xs text-zinc-500">Select a task to view its live events.</p>}
            </div>
          </DashboardPanel>

          <DashboardPanel
            title="Tasks"
            action={<span className="text-[10px] text-zinc-500">{new Intl.NumberFormat("en-US").format(tokenCount)} tokens</span>}
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
                    <span className="mt-1 block line-clamp-2 text-[10px] text-rose-700">{item.fail_reason}</span>
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
                disabled={!taskDraft.trim() || !isSandboxRunning || taskPending}
              >
                <Plus className="mr-2 size-3.5" />
                {taskPending ? "Starting..." : "Start task"}
              </Button>
            </form>
          </DashboardPanel>
        </div>
      </div>
    </div>
  )
})

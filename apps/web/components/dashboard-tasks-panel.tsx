"use client"

import { useState, type FormEvent } from "react"
import { Ban, Plus, RotateCcw, Send } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import { cn } from "@workspace/ui/lib/utils"
import { DashboardPanel, DashboardStatus } from "@/components/dashboard-primitives"
import { useDashboardTasks, useDashboardWorkspace } from "@/contexts/dashboard-context"
import { activeTaskStatuses } from "@/lib/dashboard"

export function DashboardTasksPanel() {
  const { project } = useDashboardWorkspace()
  const {
    tasks,
    tasksLoading,
    selectedTaskId,
    onSelectTask,
    onCreateTask,
    onTaskAction,
    onReply,
    taskPending,
    taskError,
    taskActionPending,
    taskActionError,
    replyPending,
    replyError,
  } = useDashboardTasks()
  const [taskDraft, setTaskDraft] = useState("")
  const [replyDraft, setReplyDraft] = useState("")
  if (!project) return null

  const task = tasks.find((item) => item.id === selectedTaskId) ?? tasks[0] ?? null
  const hasActiveTasks = tasks.some((item) => activeTaskStatuses.has(item.status))
  const isSandboxRunning = project.sandbox_status === "RUNNING"
  const provisionReady = project.provision_status === "READY"

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
    <DashboardPanel title="Tasks" action={null}>
      {(taskError || taskActionError || replyError) && (
        <div className="space-y-1 border-b border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {taskError && <p role="alert">{taskError}</p>}
          {taskActionError && <p role="alert">{taskActionError}</p>}
          {replyError && <p role="alert">{replyError}</p>}
        </div>
      )}
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
                  item.status === "INTERRUPTED" ? "text-amber-700" : "text-rose-700",
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
          {task.status === "INTERRUPTED" && (
            <Button
              variant="outline"
              size="sm"
              disabled={!taskDraft.trim() || taskActionPending || hasActiveTasks || !provisionReady || !isSandboxRunning}
              onClick={() => onTaskAction("resume", taskDraft.trim(), () => setTaskDraft(""))}
            >
              <RotateCcw className="mr-2 size-3.5" />
              Continue with new instructions
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
          disabled={!taskDraft.trim() || !isSandboxRunning || !provisionReady || hasActiveTasks || taskPending}
        >
          <Plus className="mr-2 size-3.5" />
          {taskPending ? "Starting..." : !provisionReady ? "Clone required" : hasActiveTasks ? "Project is busy" : "Start task"}
        </Button>
      </form>
    </DashboardPanel>
  )
}

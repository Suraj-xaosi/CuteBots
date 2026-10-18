"use client"

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { DefaultChatTransport, type UIMessage } from "ai"
import { useChat } from "@ai-sdk/react"
import { Send } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"

import { Button } from "@workspace/ui/components/button"
import { Textarea } from "@workspace/ui/components/textarea"
import type { TaskStream } from "@/hooks/use-task-stream"
import { dashboardQueryKeys } from "@/hooks/use-dashboard-queries"
import type { TaskChatMessage, TaskSummary } from "@/lib/agent-api"

interface ChatTaskEvent {
  id: number
  taskId: string
  type: string
  content: string
}

type AgentChatMessage = UIMessage<unknown, { taskEvent: ChatTaskEvent }>

export function DashboardTaskChat({
  task,
  stream,
  messages: initialMessages,
  loading,
}: {
  task: TaskSummary
  stream: TaskStream
  messages: TaskChatMessage[]
  loading: boolean
}) {
  const [draft, setDraft] = useState("")
  const queryClient = useQueryClient()
  const transport = useMemo(
    () => new DefaultChatTransport<AgentChatMessage>({
      api: `/api/tasks/${task.id}/chat`,
      prepareSendMessagesRequest: ({ messages, body }) => ({
        body: { ...(body ?? {}), messages: messages.slice(-1) },
      }),
    }),
    [task.id],
  )
  const { messages, status, error, sendMessage, regenerate } = useChat<AgentChatMessage>({
    id: task.id,
    messages: initialMessages,
    transport,
    onFinish: () => {
      void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.projectTasks(task.project_id) })
      void queryClient.invalidateQueries({ queryKey: dashboardQueryKeys.taskMessages(task.id) })
    },
  })
  const autoWatchStarted = useRef(false)
  const canContinue = task.status === "DONE" || task.status === "INTERRUPTED"
  const hasTerminalEvent = stream.events.some((event) => (
    event.type === "error" ||
    (event.type === "status" && /task (completed|interrupted)/i.test(event.content))
  ))
  const needsTerminalReplay = hasTerminalEvent && messages.at(-1)?.role === "user"

  useEffect(() => {
    if (
      loading ||
      task.status !== "RUNNING" ||
      stream.status !== "connected" ||
      status !== "ready" ||
      (hasTerminalEvent && !needsTerminalReplay) ||
      autoWatchStarted.current
    ) {
      return
    }

    autoWatchStarted.current = true
    const afterId = hasTerminalEvent ? 0 : findWatchCursor(stream.events)
    void regenerate({ body: { watch: true, afterId } })
  }, [loading, task.status, stream.status, stream.events, status, hasTerminalEvent, needsTerminalReplay, regenerate])

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || status !== "ready" || !canContinue) return
    setDraft("")
    void sendMessage({ text })
  }

  return (
    <section aria-label="Task conversation" className="flex min-h-0 flex-1 flex-col border-t border-zinc-200">
      <div className="flex min-h-0 flex-1 flex-col-reverse gap-3 overflow-y-auto p-3">
        {messages.slice().reverse().map((message) => (
          <article
            key={message.id}
            className={`space-y-1 text-xs ${message.role === "user" ? "ml-5 text-zinc-600" : "mr-3 text-zinc-800"}`}
          >
            <p className="text-[10px] font-semibold uppercase text-zinc-400">
              {message.role === "user" ? "You" : "CuteBots"}
            </p>
            {message.parts.map((part, index) => {
              if (part.type === "text") {
                return (
                  <p key={`${message.id}-${index}`} className="whitespace-pre-wrap break-words leading-relaxed">
                    {part.text}
                  </p>
                )
              }

              if (part.type === "data-taskEvent") {
                return (
                  <p
                    key={`${message.id}-${index}`}
                    className="rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-[10px] text-zinc-500"
                  >
                    <span className="font-semibold uppercase">{part.data.type.replaceAll("_", " ")}</span>
                    {part.data.content ? ` · ${part.data.content}` : ""}
                  </p>
                )
              }
              return null
            })}
          </article>
        ))}
        {loading && <p className="text-xs text-zinc-500">Loading conversation...</p>}
        {!loading && messages.length === 0 && (
          <p className="text-xs text-zinc-500">Conversation history is not available yet.</p>
        )}
        {status === "streaming" && (
          <p className="text-[10px] text-zinc-500" role="status">Agent is working...</p>
        )}
        {error && <p role="alert" className="text-xs text-rose-700">{error.message}</p>}
      </div>

      {canContinue && (
        <form onSubmit={submitMessage} className="flex items-end gap-2 border-t border-zinc-200 p-2">
          <Textarea
            aria-label="Message the coding agent"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask for a change or follow-up..."
            rows={2}
            disabled={status !== "ready"}
            className="min-h-0 resize-y rounded-none border-zinc-300 p-2 text-xs shadow-none focus-visible:border-zinc-600 focus-visible:ring-0"
          />
          <Button type="submit" size="icon" aria-label="Send message" disabled={!draft.trim() || status !== "ready"}>
            <Send className="size-4" />
          </Button>
        </form>
      )}
    </section>
  )
}

function findWatchCursor(events: TaskStream["events"]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "thinking") return events[index - 1]?.id ?? 0
  }
  return events.reduce((latest, event) => Math.max(latest, event.id), 0)
}

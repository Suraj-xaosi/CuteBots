"use client"

import { useEffect, useState } from "react"

import type { StreamEvent } from "@/lib/agent-api"

const AGENT_BASE_URL = process.env.NEXT_PUBLIC_AGENT_BASE_URL ?? "http://localhost:3001"

export function useTaskStream(taskId: string | null) {
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "error">("idle")

  useEffect(() => {
    const activeTaskId = taskId
    if (!activeTaskId) {
      setEvents([])
      setStatus("idle")
      return
    }

    const streamTaskId = activeTaskId as string

    let cancelled = false
    let lastEventId = 0
    const controller = new AbortController()

    async function connect() {
      setStatus("connecting")

      try {
        const response = await fetch(`${AGENT_BASE_URL}/api/tasks/${streamTaskId}/stream`, {
          headers: {
            ...(lastEventId > 0 ? { "Last-Event-ID": String(lastEventId) } : {}),
          },
          signal: controller.signal,
        })

        if (!response.ok || !response.body) {
          throw new Error(`Unable to open stream for task ${streamTaskId}`)
        }

        if (cancelled) return

        setStatus("connected")
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""

        while (!cancelled) {
          const { value, done } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const chunks = buffer.split("\n\n")
          buffer = chunks.pop() ?? ""

          for (const chunk of chunks) {
            const lines = chunk.split("\n")
            const event: {
              id?: number
              taskId?: string
              type?: string
              content?: string
              created_at?: string
            } = { taskId: streamTaskId }

            for (const line of lines) {
              if (line.startsWith("id:")) {
                const parsed = Number(line.slice(3).trim())
                if (Number.isFinite(parsed)) {
                  event.id = parsed
                  lastEventId = parsed
                }
              }
              if (line.startsWith("data:")) {
                const data = line.slice(5).trim()
                if (!data) continue

                try {
                  const parsed = JSON.parse(data) as { id?: number; taskId?: string; type?: string; content?: string; created_at?: string }
                  event.id ??= parsed.id ?? lastEventId
                  event.taskId ??= parsed.taskId ?? streamTaskId
                  event.type ??= parsed.type ?? "message"
                  event.content ??= parsed.content ?? JSON.stringify(parsed)
                  event.created_at ??= parsed.created_at ?? new Date().toISOString()
                } catch {
                  event.type ??= "message"
                  event.content ??= data
                  event.created_at ??= new Date().toISOString()
                }
              }
            }

            if (event.id && event.taskId && event.content && event.type) {
              const normalizedEvent: StreamEvent = {
                id: event.id,
                taskId: event.taskId,
                type: event.type,
                content: event.content,
                created_at: event.created_at ?? new Date().toISOString(),
              }

              setEvents((previous) => {
                const next = [...previous]
                const existingIndex = next.findIndex((item) => item.id === normalizedEvent.id)
                if (existingIndex >= 0) {
                  next[existingIndex] = normalizedEvent
                  return next
                }
                return [...next, normalizedEvent]
              })
            }
          }
        }
      } catch (error) {
        if (cancelled) return
        setStatus("error")
        console.error("Task stream error:", error)
      }
    }

    void connect()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [taskId])

  return { events, status }
}

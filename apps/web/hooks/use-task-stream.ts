"use client"

import { useEffect, useState } from "react"

import type { StreamEvent } from "@/lib/agent-api"

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

    setEvents([])
    setStatus("connecting")
    const stream = new EventSource(`/api/tasks/${streamTaskId}/stream`)
    stream.onopen = () => setStatus("connected")
    stream.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as StreamEvent
        if (!Number.isSafeInteger(event.id) || !event.content || !event.type) return
        setEvents((previous) => {
          if (previous.some((item) => item.id === event.id)) return previous
          return [...previous, event].slice(-200)
        })
      } catch {
        setStatus("error")
      }
    }
    stream.onerror = () => setStatus("connecting")
    return () => {
      stream.close()
    }
  }, [taskId])

  return { events, status }
}

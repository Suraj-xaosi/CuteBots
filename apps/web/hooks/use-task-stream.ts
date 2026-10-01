"use client"

import { useEffect, useMemo, useState } from "react"

import type { StreamEvent } from "@/lib/agent-api"

type StreamStatus = "idle" | "connecting" | "connected" | "error"

interface TaskStreamState {
  taskId: string | null
  events: StreamEvent[]
  status: StreamStatus
}

const EMPTY_EVENTS: StreamEvent[] = []

export function useTaskStream(taskId: string | null): { events: StreamEvent[]; status: StreamStatus } {
  const [streamState, setStreamState] = useState<TaskStreamState>({
    taskId: null,
    events: [],
    status: "idle",
  })

  useEffect(() => {
    if (!taskId) {
      return
    }

    const updateStatus = (status: StreamStatus) => {
      setStreamState((current) => ({
        taskId,
        events: current.taskId === taskId ? current.events : [],
        status,
      }))
    }
    const stream = new EventSource(`/api/tasks/${taskId}/stream`)
    stream.onopen = () => updateStatus("connected")
    stream.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as StreamEvent
        if (!Number.isSafeInteger(event.id) || !event.content || !event.type) return
        setStreamState((current) => {
          const events = current.taskId === taskId ? current.events : []
          if (events.some((item) => item.id === event.id)) return current
          return { taskId, events: [...events, event].slice(-200), status: current.status }
        })
      } catch {
        updateStatus("error")
      }
    }
    stream.onerror = () => updateStatus("connecting")
    return () => {
      stream.close()
    }
  }, [taskId])

  const events = taskId && streamState.taskId === taskId ? streamState.events : EMPTY_EVENTS
  const status = !taskId ? "idle" : streamState.taskId === taskId ? streamState.status : "connecting"

  return useMemo(() => ({ events, status }), [events, status])
}

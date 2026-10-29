"use client"

import type { Dispatch, SetStateAction } from "react"
import {
  AgentRunStatus,
  isAgentRunLogPayload,
  type ActivityItem,
  type ConversationDetails,
} from "@workspace/types"
import { getRunActivity } from "@/lib/actions/run-activity"

export async function connectRunStream(
  runId: string,
  isCurrent: () => boolean,
  setActivities: Dispatch<SetStateAction<ActivityItem[]>>,
  setConversation: Dispatch<SetStateAction<ConversationDetails | null>>,
  setError: (message: string) => void
) {
  const activity = await getRunActivity(runId)
  if (!isCurrent()) return null
  if (activity.ok) setActivities(activity.data)
  else setError(activity.error)

  const after = activity.ok ? activity.data.at(-1)?.id ?? 0 : 0
  const source = new EventSource(`/api/runs/${runId}/events?after=${after}`)
  source.onmessage = (event) => {
    if (!isCurrent()) return
    try {
      const value: unknown = JSON.parse(event.data)
      if (!isAgentRunLogPayload(value, runId)) return
      const item: ActivityItem = {
        id: value.id,
        runId: value.runId,
        type: value.type,
        content: value.content,
        createdAt: new Date(value.createdAt),
      }
      setActivities((current) => [...current, item].slice(-100))
      if (item.type === "status") {
        const content = item.content.toLowerCase()
        const status = content.includes("waiting")
          ? AgentRunStatus.WAITING_FOR_INPUT
          : content.includes("completed")
            ? AgentRunStatus.DONE
            : content.includes("interrupted") || content.includes("cancelled")
              ? AgentRunStatus.INTERRUPTED
              : AgentRunStatus.RUNNING
        setConversation((current) =>
          current && current.runs[0]?.id === runId
            ? {
                ...current,
                runs: [
                  {
                    ...current.runs[0],
                    status,
                    ...(status === AgentRunStatus.DONE
                      ? { summary: current.messages.at(-1)?.content ?? null }
                      : {}),
                  },
                  ...current.runs.slice(1),
                ],
              }
            : current
        )
      }
      if (item.type === "error") {
        setConversation((current) =>
          current && current.runs[0]?.id === runId
            ? {
                ...current,
                runs: [
                  { ...current.runs[0], status: AgentRunStatus.FAILED, failReason: item.content },
                  ...current.runs.slice(1),
                ],
              }
            : current
        )
      }
      if (item.type === "message") {
        setConversation((current) =>
          current && current.runs[0]?.id === runId
            ? {
                ...current,
                messages: [
                  ...current.messages,
                  {
                    id: `live-${item.id}`,
                    role: "assistant",
                    content: item.content,
                    runId,
                    createdAt: item.createdAt,
                  },
                ],
              }
            : current
        )
      }
    } catch {
      setError("Received an invalid live update")
    }
  }
  return source
}

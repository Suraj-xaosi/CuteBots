"use client"

import { AgentRunStatus } from "@workspace/types"
import { Badge } from "@workspace/ui/components/badge"
import { useConversation } from "@/hooks/use-conversation"
import { StatusIcon, statusLabel } from "./run-status"

// Each row: icon, id (truncates), status badge (never shrinks). A long status
// like "Waiting for input" therefore can't push the row wider than the panel.
export function RunHistory({ conversationId }: { conversationId: string | null }) {
  const { data } = useConversation(conversationId)
  const runs = data?.runs ?? []

  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-medium">Run history</h3>
      {runs.length ? (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-1">
          {runs.map((run) => (
            <li key={run.id} className="flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5">
              <StatusIcon status={run.status} />
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {run.id.slice(-8)}
              </span>
              <Badge
                variant={run.status === AgentRunStatus.FAILED ? "destructive" : "secondary"}
                className="shrink-0"
              >
                {statusLabel(run.status)}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      )}
    </section>
  )
}
"use client"

import { Square } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { canStop } from "@/hooks/run-phase"
import { useCancelRun, useRunPhase } from "@/hooks/use-conversation"
import { RunNotice } from "../run/run-notice"
import { StatusIcon } from "../run/run-status"

export function RunStrip({ conversationId }: { conversationId: string | null }) {
  const { run, phase } = useRunPhase(conversationId)
  const cancel = useCancelRun(conversationId)

  if (!run || phase === "none" || phase === "done") return null

  const stopping = canStop(phase)
  const label =
    phase === "starting"
      ? "Starting..."
      : phase === "working"
        ? "Working..."
        : phase === "waiting"
          ? "Waiting for your reply"
          : phase === "stopped"
            ? "Run was stopped"
            : null

  return (
    <div className="mx-3 mb-2 grid gap-2 rounded-md border px-3 py-2">
      {label ? (
        <div className="flex items-center gap-2 text-sm">
          <StatusIcon status={run.status} />
          <span className="min-w-0 flex-1">{label}</span>
          {stopping ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="shrink-0"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(run.id)}
            >
              <Square className="size-3.5" />
              Stop
            </Button>
          ) : null}
        </div>
      ) : null}
      {phase === "failed" || phase === "stopped" ? (
        <RunNotice run={run} />
      ) : null}
    </div>
  )
}
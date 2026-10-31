"use client"

import { ChevronDown } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { useCancelRun, useCurrentRun } from "@/hooks/use-conversation"
import { useRunStream } from "@/hooks/use-run-stream"
import { useSelectedProject } from "@/hooks/use-selection"
import { StatusIcon, statusLabel } from "./run-status"

// The "IDLE v" pill from the design. Everything the old status card did is in
// the menu: sandbox status (read only), Reconnect, Cancel run, and the notice
// when live updates are paused. Summary and failure reason moved to RunNotice.
export function RunStatusMenu({ conversationId }: { conversationId: string | null }) {
  const project = useSelectedProject()
  const { run, isActive } = useCurrentRun(conversationId)
  const cancel = useCancelRun(conversationId)
  const stream = useRunStream({
    conversationId,
    runId: run?.id ?? null,
    enabled: isActive,
  })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="min-w-0 shrink">
          <StatusIcon status={run?.status ?? null} />
          <span className="truncate">{statusLabel(run?.status ?? null)}</span>
          <ChevronDown className="opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          Sandbox: {project?.sandboxStatus.toLowerCase() ?? "unknown"}
        </DropdownMenuLabel>
        {isActive && stream.status === "retrying" ? (
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            Live updates paused. Retrying…
          </DropdownMenuLabel>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!isActive} onSelect={() => stream.reconnect()}>
          Reconnect
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={!isActive || !run || cancel.isPending}
          onSelect={(event) => {
            // Keep the menu open so a failed cancel can show its error here.
            event.preventDefault()
            if (run) cancel.mutate(run.id)
          }}
        >
          {cancel.isPending ? "Cancelling…" : "Cancel run"}
        </DropdownMenuItem>
        {cancel.error ? (
          <DropdownMenuLabel role="alert" className="font-normal text-destructive">
            {cancel.error.message}
          </DropdownMenuLabel>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
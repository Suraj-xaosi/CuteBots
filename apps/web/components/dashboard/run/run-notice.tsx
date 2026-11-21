import { AgentRunStatus, type RunItem } from "@workspace/types"
import { cn } from "@workspace/ui/lib/utils"

// The run's summary and failure reason, shown only when they exist.
// CHANGED: the reason is red only when the run FAILED. When the user pressed
// Stop (or the server restarted) the run is INTERRUPTED, and the reason
// ("Run stopped by user") is plain grey text, not an error.
export function RunNotice({ run }: { run: RunItem | null }) {
  if (!run?.summary && !run?.failReason) return null

  const failed = run.status === AgentRunStatus.FAILED

  return (
    <div className="grid gap-2">
      {run.summary ? (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {run.summary}
        </p>
      ) : null}
      {run.failReason ? (
        <p
          role={failed ? "alert" : undefined}
          className={cn(
            "whitespace-pre-wrap break-words text-sm",
            failed ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {run.failReason}
        </p>
      ) : null}
    </div>
  )
}
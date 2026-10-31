import type { RunItem } from "@workspace/types"

// The run's summary and failure reason, shown only when they exist.
export function RunNotice({ run }: { run: RunItem | null }) {
  if (!run?.summary && !run?.failReason) return null

  return (
    <div className="grid gap-2">
      {run.summary ? (
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {run.summary}
        </p>
      ) : null}
      {run.failReason ? (
        <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
          {run.failReason}
        </p>
      ) : null}
    </div>
  )
}
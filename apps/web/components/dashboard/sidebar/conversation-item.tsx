import { Trash2 } from "lucide-react"
import type { AgentRunStatusValue } from "@workspace/types"
import { Button } from "@workspace/ui/components/button"
import { StatusIcon, statusLabel } from "@/components/dashboard/run/run-status"
import { phaseOf } from "@/hooks/run-phase"

// One row. The label truncates instead of widening the list, and the row
// itself can shrink below its content (min-w-0 via the grid column above).
// CHANGED: `status` is the status of the conversation's latest run. An icon is
// shown only when it needs attention (working, waiting for the user, failed).
// A finished or stopped conversation stays quiet, so the list is not noisy.
export function ConversationItem({
  title,
  status = null,
  active,
  onSelect,
  onDelete,
}: {
  title: string | null | undefined
  status?: AgentRunStatusValue | null
  active: boolean
  onSelect: () => void
  onDelete?: () => void
}) {
  const phase = phaseOf(status)
  const showStatus =
    phase === "starting" || phase === "working" || phase === "waiting" || phase === "failed"

  return (
    <div className="flex items-center gap-1">
      <Button
        variant={active ? "secondary" : "ghost"}
        aria-current={active ? "true" : undefined}
        className="h-auto min-h-9 min-w-0 flex-1 justify-start overflow-hidden px-3 py-2 text-left"
        onClick={onSelect}
      >
        <span className="min-w-0 flex-1 truncate">{title || "New conversation"}</span>
        {showStatus ? (
          <>
            <StatusIcon status={status} />
            <span className="sr-only">{statusLabel(status)}</span>
          </>
        ) : null}
      </Button>
      {onDelete ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete conversation ${title || "untitled"}`}
          className="text-muted-foreground hover:text-destructive"
          onClick={(event) => {
            event.stopPropagation()
            onDelete()
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  )
}
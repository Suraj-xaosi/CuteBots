import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CircleStop,
  Clock,
  LoaderCircle,
} from "lucide-react"
import { AgentRunStatus, type AgentRunStatusValue } from "@workspace/types"
import { cn } from "@workspace/ui/lib/utils"

// Black and white: only a failed run gets the destructive colour.
// CHANGED: every status has its own icon now. Before, QUEUED, INTERRUPTED and
// AWAITING_APPROVAL all showed the same dashed circle as "no run yet".
export function StatusIcon({
  status,
  className,
}: {
  status: AgentRunStatusValue | null
  className?: string
}) {
  const base = cn("size-4 shrink-0", className)

  if (status === AgentRunStatus.DONE) return <CircleCheck className={base} aria-hidden />
  if (status === AgentRunStatus.RUNNING)
    return <LoaderCircle className={cn(base, "animate-spin")} aria-hidden />
  if (status === AgentRunStatus.WAITING_FOR_INPUT) return <CircleDot className={base} aria-hidden />
  if (status === AgentRunStatus.FAILED)
    return <Ban className={cn(base, "text-destructive")} aria-hidden />
  if (status === AgentRunStatus.QUEUED)
    return <Clock className={cn(base, "text-muted-foreground")} aria-hidden />
  if (status === AgentRunStatus.INTERRUPTED)
    return <CircleStop className={cn(base, "text-muted-foreground")} aria-hidden />
  if (status === AgentRunStatus.AWAITING_APPROVAL)
    return <CircleHelp className={base} aria-hidden />
  // No run yet.
  return <CircleDashed className={cn(base, "text-muted-foreground")} aria-hidden />
}

// "WAITING_FOR_INPUT" -> "Waiting for input"
export function statusLabel(status: string | null) {
  if (!status) return "Idle"
  const text = status.replaceAll("_", " ").toLowerCase()
  return text.charAt(0).toUpperCase() + text.slice(1)
}
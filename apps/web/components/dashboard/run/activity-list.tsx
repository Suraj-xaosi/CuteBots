"use client"

import { useState } from "react"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { useRunActivity } from "@/hooks/use-run-activity"

// Same behaviour as before: a toggle with a count, open by default. Read only;
// the stream is what appends to this list. The open flag is local state.
export function ActivityList({ runId }: { runId: string | null }) {
  const activities = useRunActivity(runId)
  const [open, setOpen] = useState(true)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="grid gap-2">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="justify-start px-0 hover:bg-transparent">
          Activity {open ? "−" : "+"}
          <Badge variant="outline">{activities.length}</Badge>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-2 border-l pl-3">
          {activities.length ? (
            activities.map((activity) => (
              <li key={activity.id} className="grid min-w-0 gap-0.5">
                <span className="text-xs font-medium capitalize">
                  {activity.type.replaceAll("_", " ")}
                </span>
                <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                  {activity.content}
                </p>
              </li>
            ))
          ) : (
            <li className="text-sm text-muted-foreground">Run activity will appear here.</li>
          )}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
import { Trash2 } from "lucide-react"
import { Button } from "@workspace/ui/components/button"

// One row. The label truncates instead of widening the list, and the row
// itself can shrink below its content (min-w-0 via the grid column above).
export function ConversationItem({
  title,
  active,
  onSelect,
  onDelete,
}: {
  title: string | null | undefined
  active: boolean
  onSelect: () => void
  onDelete?: () => void
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        variant={active ? "secondary" : "ghost"}
        aria-current={active ? "true" : undefined}
        className="h-auto min-h-9 min-w-0 flex-1 justify-start overflow-hidden px-3 py-2 text-left"
        onClick={onSelect}
      >
        <span className="min-w-0 flex-1 truncate">{title || "New conversation"}</span>
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
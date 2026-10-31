import { Button } from "@workspace/ui/components/button"

// One row. The label truncates instead of widening the list, and the row
// itself can shrink below its content (min-w-0 via the grid column above).
export function ConversationItem({
  title,
  active,
  onSelect,
}: {
  title: string | null | undefined
  active: boolean
  onSelect: () => void
}) {
  return (
    <Button
      variant={active ? "secondary" : "ghost"}
      aria-current={active ? "true" : undefined}
      className="h-auto min-h-9 w-full justify-start overflow-hidden px-3 py-2 text-left"
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1 truncate">{title || "New conversation"}</span>
    </Button>
  )
}
import type { ConversationDetails } from "@workspace/types"
import { cn } from "@workspace/ui/lib/utils"

type Message = ConversationDetails["messages"][number]

const LABELS: Record<string, string> = { user: "You", assistant: "CuteBots" }

// A plain div, not a Card. min-w-0 + break-words: a 200 character string with
// no spaces wraps inside the bubble instead of pushing the panel wider.
export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user"

  return (
    <div
      className={cn(
        "flex min-w-0 max-w-[88%] flex-col gap-1 rounded-xl border px-3 py-2",
        isUser ? "ml-auto bg-muted" : "mr-auto bg-background"
      )}
    >
      <span className="text-xs text-muted-foreground">{LABELS[message.role] ?? "Tool"}</span>
      <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
    </div>
  )
}
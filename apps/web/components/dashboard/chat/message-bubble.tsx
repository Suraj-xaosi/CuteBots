import type { ConversationDetails } from "@workspace/types"
import { cn } from "@workspace/ui/lib/utils"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

type Message = ConversationDetails["messages"][number]

const LABELS: Record<string, string> = { user: "You", assistant: "CuteBots" }

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
      <div className="text-sm text-foreground [&_p]:m-0 [&_p+_p]:mt-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:ml-4 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground/30 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
      </div>
    </div>
  )
}
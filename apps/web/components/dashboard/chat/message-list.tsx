"use client"

import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { useConversation } from "@/hooks/use-conversation"
import { ChatEmpty } from "./chat-empty"
import { MessageBubble } from "./message-bubble"

// Rendered inside PanelBody, which owns the scrolling. This only decides what
// to show: messages, loading, error, or the empty state.
export function MessageList({ conversationId }: { conversationId: string | null }) {
  const conversation = useConversation(conversationId)
  const messages = conversation.data?.messages

  if (messages?.length) {
    return (
      <ul className="mx-auto grid w-full max-w-3xl grid-cols-[minmax(0,1fr)] gap-4 p-4 md:p-6">
        {messages.map((message) => (
          <li key={message.id} className="flex min-w-0">
            <MessageBubble message={message} />
          </li>
        ))}
      </ul>
    )
  }

  if (conversation.isError && !conversation.data) {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <div className="grid w-full max-w-md gap-3 rounded-xl border border-destructive/30 p-4 text-sm">
          <p role="alert" className="text-destructive">
            {conversation.error?.message}
          </p>
          <Button variant="outline" size="sm" onClick={() => void conversation.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  if (conversation.isLoading) {
    return (
      <div className="mx-auto grid w-full max-w-3xl gap-4 p-4 md:p-6">
        <Skeleton className="h-16 w-2/3" />
        <Skeleton className="ml-auto h-12 w-1/2" />
        <Skeleton className="h-20 w-3/4" />
      </div>
    )
  }

  return (
    <div className="grid min-h-full place-items-center p-6">
      <ChatEmpty />
    </div>
  )
}
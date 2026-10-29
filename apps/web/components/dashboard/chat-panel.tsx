"use client"

import { useRef } from "react"
import { FolderOpen, Send } from "lucide-react"
import type { ConversationDetails } from "@workspace/types"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { ScrollArea } from "@workspace/ui/components/scroll-area"
import { Textarea } from "@workspace/ui/components/textarea"

export function ChatPanel({
  conversation,
  pending,
  error,
  onSend,
  onOpenFiles,
}: {
  conversation: ConversationDetails | null
  pending: boolean
  error: string | null
  onSend: (content: string) => Promise<boolean>
  onOpenFiles: () => void
}) {
  const input = useRef<HTMLTextAreaElement>(null)

  const send = async () => {
    const content = input.current?.value.trim()
    if (!content || pending) return
    if (await onSend(content)) {
      if (input.current) input.current.value = ""
      input.current?.focus()
    }
  }

  return (
    <Card className="flex h-full min-h-0 flex-col rounded-none border-0 py-0">
      <CardHeader className="flex-row items-center justify-between border-b p-4 md:px-6">
        <CardContent className="min-w-0 p-0">
          <CardTitle className="truncate">
            {conversation?.title || "Conversation"}
          </CardTitle>
          <CardDescription className="mt-1">
            Project history stays together. Each request starts an agent run.
          </CardDescription>
        </CardContent>
        <Button variant="outline" onClick={onOpenFiles} disabled={!conversation}>
          <FolderOpen />
          Files
        </Button>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-0">
        <ScrollArea className="h-full">
          <CardContent className="mx-auto grid w-full max-w-3xl gap-4 p-4 md:p-6">
            {conversation?.messages.length ? (
              conversation.messages.map((message) => (
                <Card
                  key={message.id}
                  className={
                    message.role === "user"
                      ? "ml-auto w-fit max-w-[88%] border-primary/20 bg-primary/5 py-3"
                      : "mr-auto w-fit max-w-[88%] py-3"
                  }
                >
                  <CardHeader className="gap-1 px-3 py-0">
                    <CardTitle className="text-xs text-muted-foreground">
                      {message.role === "user" ? "You" : message.role === "assistant" ? "CuteBots" : "Tool"}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-3">
                    <CardDescription className="whitespace-pre-wrap break-words text-foreground">
                      {message.content}
                    </CardDescription>
                  </CardContent>
                </Card>
              ))
            ) : (
              <Card className="mx-auto mt-12 max-w-lg border-dashed">
                <CardHeader>
                  <CardTitle>What should we build?</CardTitle>
                  <CardDescription>
                    Ask CuteBots to explore, edit, and test your repository.
                  </CardDescription>
                </CardHeader>
              </Card>
            )}
            {error ? (
              <Card className="border-destructive/30 bg-destructive/5">
                <CardContent className="p-3 text-sm text-destructive">
                  {error}
                </CardContent>
              </Card>
            ) : null}
          </CardContent>
        </ScrollArea>
      </CardContent>
      <CardContent className="border-t p-4 md:px-6">
        <CardContent className="mx-auto grid max-w-3xl gap-2 rounded-xl border bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
          <Textarea
            ref={input}
            rows={3}
            maxLength={50_000}
            placeholder="Ask for a change, an explanation, or a review…"
            disabled={!conversation || pending}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            className="resize-y border-0 shadow-none focus-visible:ring-0"
          />
          <CardContent className="flex items-center justify-between gap-3 p-0">
            <CardDescription className="text-xs">
              Enter to send · Shift+Enter for a new line
            </CardDescription>
            <Button onClick={() => void send()} disabled={!conversation || pending}>
              <Send />
              {pending ? "Working…" : "Send"}
            </Button>
          </CardContent>
        </CardContent>
      </CardContent>
    </Card>
  )
}

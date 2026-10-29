"use client"

import { MessageSquarePlus } from "lucide-react"
import type { ConversationItem } from "@workspace/types"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { ScrollArea } from "@workspace/ui/components/scroll-area"

export function ConversationSidebar({
  conversations,
  selectedId,
  disabled,
  onCreate,
  onSelect,
}: {
  conversations: ConversationItem[]
  selectedId: string | null
  disabled: boolean
  onCreate: () => void
  onSelect: (conversation: ConversationItem) => void
}) {
  return (
    <Card className="h-full min-h-0 rounded-none border-0 py-0">
      <CardHeader className="gap-3 border-b p-4">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Conversations
        </CardTitle>
        <Button variant="secondary" className="w-full justify-start" onClick={onCreate} disabled={disabled}>
          <MessageSquarePlus />
          New conversation
        </Button>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-2">
        <ScrollArea className="h-full">
          <CardContent className="grid gap-1 p-0">
            {conversations.length ? conversations.map((conversation) => (
              <Button
                key={conversation.id}
                variant={selectedId === conversation.id ? "secondary" : "ghost"}
                className="h-auto min-h-10 justify-start overflow-hidden text-left"
                onClick={() => onSelect(conversation)}
              >
                {conversation.title || "New conversation"}
              </Button>
            )) : (
              <CardContent className="p-4">
                <CardTitle className="text-sm">No conversations yet</CardTitle>
              </CardContent>
            )}
          </CardContent>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

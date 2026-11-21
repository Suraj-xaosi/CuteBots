"use client"

import { Panel, PanelBody } from "@/components/dashboard/layout/panel"
import { useConversation } from "@/hooks/use-conversation"
import { useActiveConversationId } from "@/hooks/use-selection"
import { ChatToolbar } from "./chat-toolbar"
import { Composer } from "./composer"
import { MessageList } from "./message-list"
import { RunStrip } from "./run-strip"

// Four stacked parts: fixed toolbar, scrolling messages, the run strip (status
// and Stop, shown only while it matters) and the fixed composer.
// The conversation title is gone from the screen (the sidebar shows it) but
// stays as a heading for screen readers.
export function ChatPanel() {
  const conversationId = useActiveConversationId()
  const { data } = useConversation(conversationId)

  return (
    <Panel aria-label="Chat">
      <h2 className="sr-only">{data?.title || "Conversation"}</h2>
      <ChatToolbar />
      <PanelBody>
        <MessageList conversationId={conversationId} />
      </PanelBody>
      <RunStrip conversationId={conversationId} />
      <Composer conversationId={conversationId} />
    </Panel>
  )
}
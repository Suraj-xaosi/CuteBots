"use client"

import { MessageSquarePlus } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Panel, PanelBody } from "@/components/dashboard/layout/panel"
import { useConversations, useCreateConversation } from "@/hooks/use-Conversations"
import { useActiveConversationId, useSelectedProjectId } from "@/hooks/use-selection"
import { useAppDispatch } from "@/store/hooks"
import { workspaceActions } from "@/store/workspace-slice"
import { ConversationItem } from "./conversation-item"

// The "New conversation" button stays in the fixed part above the list, so it
// is always reachable no matter how long the list gets. Only the list scrolls.
export function ConversationSidebar() {
  const dispatch = useAppDispatch()
  const projectId = useSelectedProjectId()
  const activeId = useActiveConversationId()
  const conversations = useConversations(projectId)
  const create = useCreateConversation()

  const items = conversations.data

  return (
    // h-auto flex-1: this panel shares its column with the brand block, so it
    // takes the remaining height instead of the default h-full.
    <Panel aria-label="Conversations" className="h-auto flex-1">
      <div className="grid shrink-0 gap-2 p-3 pb-2">
        <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Conversations
        </h2>
        <Button
          variant="secondary"
          className="w-full justify-start"
          disabled={!projectId || create.isPending}
          onClick={() => {
            if (projectId) create.mutate(projectId)
          }}
        >
          <MessageSquarePlus />
          New conversation
        </Button>
        {create.error ? (
          <p role="alert" className="px-1 text-xs text-destructive">
            {create.error.message}
          </p>
        ) : null}
      </div>
      <PanelBody className="p-2 pt-0">
        {items?.length ? (
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-1">
            {items.map((conversation) => (
              <li key={conversation.id}>
                <ConversationItem
                  title={conversation.title}
                  active={activeId === conversation.id}
                  onSelect={() => dispatch(workspaceActions.conversationSelected(conversation.id))}
                />
              </li>
            ))}
          </ul>
        ) : conversations.isLoading ? (
          <div className="grid gap-1">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-9" />
            ))}
          </div>
        ) : conversations.isError ? (
          <div className="grid gap-2 px-2 py-3 text-sm">
            <p className="text-destructive">{conversations.error?.message}</p>
            <Button variant="outline" size="sm" onClick={() => void conversations.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="px-2 py-3 text-sm text-muted-foreground">No conversations yet</p>
        )}
      </PanelBody>
    </Panel>
  )
}
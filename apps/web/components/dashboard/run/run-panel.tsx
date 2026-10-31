"use client"

import { Panel, PanelBody } from "@/components/dashboard/layout/panel"
import { useCurrentRun } from "@/hooks/use-conversation"
import { useActiveConversationId } from "@/hooks/use-selection"
import { ActivityList } from "./activity-list"
import { RunHeader } from "./run-header"
import { RunHistory } from "./run-history"
import { RunNotice } from "./run-notice"

// Fixed header, then one scrolling body with three small sections. Each
// section reads its own data from the cache; this component only knows which
// conversation and run are current.
export function RunPanel() {
  const conversationId = useActiveConversationId()
  const { run } = useCurrentRun(conversationId)

  return (
    <Panel aria-label="Agent run">
      <h2 className="sr-only">Agent run</h2>
      <RunHeader conversationId={conversationId} />
      <PanelBody className="p-4 pt-2">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
          <RunNotice run={run} />
          <RunHistory conversationId={conversationId} />
          <ActivityList runId={run?.id ?? null} />
        </div>
      </PanelBody>
    </Panel>
  )
}
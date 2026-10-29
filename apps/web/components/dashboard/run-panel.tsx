"use client"

import { useState } from "react"
import { Ban, CircleCheck, CircleDashed, CircleDot, LoaderCircle } from "lucide-react"
import {
  AgentRunStatus,
  isActiveAgentRunStatus,
  type AgentRunStatusValue,
  type SandboxStatusValue,
} from "@workspace/types"
import type { ActivityItem, RunItem } from "@workspace/types"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { ScrollArea } from "@workspace/ui/components/scroll-area"

const statusIcon = (status: AgentRunStatusValue) => {
  if (status === AgentRunStatus.DONE) return <CircleCheck className="text-emerald-600" />
  if (status === AgentRunStatus.RUNNING) return <LoaderCircle className="animate-spin text-primary" />
  if (status === AgentRunStatus.WAITING_FOR_INPUT) return <CircleDot className="text-amber-600" />
  if (status === AgentRunStatus.FAILED) return <Ban className="text-destructive" />
  return <CircleDashed className="text-muted-foreground" />
}

export function RunPanel({
  runs,
  activities,
  sandboxStatus,
  pending,
  onCancel,
  onReconnect,
}: {
  runs: RunItem[]
  activities: ActivityItem[]
  sandboxStatus: SandboxStatusValue
  pending: boolean
  onCancel: (runId: string) => void
  onReconnect: () => void
}) {
  const [showActivity, setShowActivity] = useState(true)
  const current = runs[0] ?? null
  const busy = current && isActiveAgentRunStatus(current.status)

  return (
    <Card className="h-full min-h-0 rounded-none border-0 py-0">
      <CardHeader className="border-b p-4">
        <CardTitle>Agent run</CardTitle>
        <CardDescription>Sandbox: {sandboxStatus.toLowerCase()}</CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 p-3">
        <ScrollArea className="h-full">
          <CardContent className="grid content-start gap-5 p-0">
            <Card className="gap-2 p-3">
              <CardContent className="flex items-center justify-between gap-2 p-0">
                <CardTitle className="flex items-center gap-2 text-sm">
                  {current ? statusIcon(current.status) : <CircleDashed />}
                  {current?.status ?? "IDLE"}
                </CardTitle>
                {busy ? (
                  <CardContent className="flex gap-2 p-0">
                    <Button variant="outline" size="sm" onClick={onReconnect}>
                      Reconnect
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() => onCancel(current.id)}
                    >
                      Cancel
                    </Button>
                  </CardContent>
                ) : null}
              </CardContent>
              {current?.summary ? (
                <CardDescription className="whitespace-pre-wrap">
                  {current.summary}
                </CardDescription>
              ) : null}
              {current?.failReason ? (
                <CardDescription className="text-destructive">
                  {current.failReason}
                </CardDescription>
              ) : null}
            </Card>
            <CardContent className="grid gap-2 p-0">
              <CardTitle className="text-sm">Run history</CardTitle>
              {runs.length ? runs.map((run) => (
                <Card key={run.id} className="flex-row items-center justify-between gap-2 p-2">
                  <CardContent className="flex min-w-0 items-center gap-2 p-0">
                    {statusIcon(run.status)}
                    <CardDescription className="truncate">
                      {run.id.slice(-8)}
                    </CardDescription>
                  </CardContent>
                  <Badge variant={run.status === AgentRunStatus.FAILED ? "destructive" : "secondary"}>
                    {run.status}
                  </Badge>
                </Card>
              )) : (
                <CardDescription>No runs yet.</CardDescription>
              )}
            </CardContent>
            <CardContent className="grid gap-2 p-0">
              <Button
                variant="ghost"
                className="justify-start px-0"
                onClick={() => setShowActivity((visible) => !visible)}
              >
                Activity {showActivity ? "−" : "+"}
                <Badge variant="outline">{activities.length}</Badge>
              </Button>
              {showActivity ? (
                <CardContent className="grid gap-2 border-l pl-3">
                  {activities.length ? activities.map((activity) => (
                    <Card key={activity.id} className="gap-1 border-0 bg-transparent p-1 shadow-none">
                      <CardTitle className="text-xs capitalize">{activity.type.replaceAll("_", " ")}</CardTitle>
                      <CardDescription className="whitespace-pre-wrap break-words">
                        {activity.content}
                      </CardDescription>
                    </Card>
                  )) : (
                    <CardDescription>Run activity will appear here.</CardDescription>
                  )}
                </CardContent>
              ) : null}
            </CardContent>
          </CardContent>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

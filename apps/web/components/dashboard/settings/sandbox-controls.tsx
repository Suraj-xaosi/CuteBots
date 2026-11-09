"use client"

import { Play, RefreshCw, Square, Trash2 } from "lucide-react"
import { ProjectProvisionStatus, SandboxStatus } from "@workspace/types"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { useSandboxActions, useSandboxStatus } from "@/hooks/use-sandbox"

export function SandboxControls({
  projectId,
  enabled,
}: {
  projectId: string
  enabled: boolean
}) {
  const status = useSandboxStatus(projectId, enabled)
  const actions = useSandboxActions(projectId)
  const isMutating =
    actions.start.isPending ||
    actions.stop.isPending ||
    actions.destroy.isPending
  const sandbox = status.data
  const canDestroy =
    sandbox?.status === SandboxStatus.RUNNING ||
    sandbox?.provisionStatus === ProjectProvisionStatus.READY
  const actionError =
    actions.start.error ?? actions.stop.error ?? actions.destroy.error

  return (
    <section
      className="grid gap-3 border-t border-border pt-4"
      aria-labelledby="sandbox-controls-title"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 id="sandbox-controls-title" className="text-sm font-semibold">
          Project sandbox
        </h3>
        {sandbox ? (
          <Badge variant={sandbox.error ? "destructive" : "outline"}>
            {sandbox.status.toLowerCase()}
          </Badge>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        Stop preserves the workspace. Destroy removes the sandbox and all
        uncommitted files.
      </p>
      {sandbox?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {sandbox.error}
        </p>
      ) : null}
      {status.isError ? (
        <div className="flex items-center justify-between gap-3">
          <p role="alert" className="text-sm text-destructive">
            {status.error.message}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void status.refetch()}
            disabled={status.isFetching || isMutating}
          >
            <RefreshCw />
            Retry
          </Button>
        </div>
      ) : null}
      {actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {actionError.message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={
            !sandbox ||
            sandbox.status === SandboxStatus.RUNNING ||
            sandbox.status === SandboxStatus.STARTING ||
            sandbox.status === SandboxStatus.DESTROYING ||
            isMutating
          }
          onClick={() => actions.start.mutate()}
        >
          <Play />
          {actions.start.isPending ? "Starting…" : "Start sandbox"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={
            !sandbox || sandbox.status !== SandboxStatus.RUNNING || isMutating
          }
          onClick={() => actions.stop.mutate()}
        >
          <Square />
          {actions.stop.isPending ? "Stopping…" : "Stop sandbox"}
        </Button>
        {canDestroy ? (
          <Button
            type="button"
            variant="destructive"
            disabled={
              isMutating || sandbox?.status === SandboxStatus.DESTROYING
            }
            onClick={() => {
              const confirmed = window.confirm(
                "Destroy this sandbox? The cloned repository and all uncommitted files inside it will be permanently deleted. The project and conversations will remain."
              )
              if (confirmed) actions.destroy.mutate()
            }}
          >
            <Trash2 />
            {actions.destroy.isPending ? "Destroying…" : "Destroy sandbox"}
          </Button>
        ) : null}
      </div>
      {status.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading sandbox status…</p>
      ) : null}
      {sandbox ? (
        <p className="text-xs text-muted-foreground">
          Setup: {sandbox.provisionStatus.toLowerCase()}
        </p>
      ) : null}
    </section>
  )
}

"use client"

import { memo, type CSSProperties } from "react"
import { Play, RefreshCw, Square } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { DashboardStatus } from "@/components/dashboard-primitives"
import { DashboardActivityPanel } from "@/components/dashboard-activity-panel"
import { DashboardFilePreviewPanel } from "@/components/dashboard-file-preview-panel"
import { DashboardFilesPanel } from "@/components/dashboard-files-panel"
import { DashboardTasksPanel } from "@/components/dashboard-tasks-panel"
import { useDashboardTasks, useDashboardWorkspace } from "@/contexts/dashboard-context"
import { activeTaskStatuses } from "@/lib/dashboard"
import { useWorkspaceLayout } from "@/hooks/use-workspace-layout"

export const DashboardProjectContent = memo(function DashboardProjectContent() {
  const {
    project,
    onSandboxToggle,
    sandboxPending,
    sandboxError,
    onRetryProvisioning,
    provisioningRetryPending,
    provisioningRetryError,
  } = useDashboardWorkspace()
  const { tasks } = useDashboardTasks()
  const {
    layout,
    gridRef,
    beginHorizontalResize,
    moveHorizontalResize,
    beginVerticalResize,
    moveVerticalResize,
    finishResize,
    resizeWithKeyboard,
  } = useWorkspaceLayout()

  if (!project) return null

  const hasActiveTasks = tasks.some((item) => activeTaskStatuses.has(item.status))
  const isSandboxRunning = project.sandbox_status === "RUNNING"

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{project.name}</h2>
          <p className="truncate text-xs text-zinc-500">{project.repo_url}</p>
          <p className="mt-1 text-[10px] text-zinc-500">
            {project.branch_name ? `Working branch: ${project.branch_name}` : "Project branch pending"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DashboardStatus value={project.sandbox_status} />
          <DashboardStatus value={project.provision_status} />
          <Button
            variant="outline"
            size="sm"
            disabled={sandboxPending || project.provision_status === "PROVISIONING" || (isSandboxRunning && hasActiveTasks)}
            onClick={onSandboxToggle}
          >
            {isSandboxRunning ? (
              <>
                <Square className="mr-2 size-3.5" />
                Destroy
              </>
            ) : (
              <>
                <Play className="mr-2 size-3.5" />
                Start
              </>
            )}
          </Button>
        </div>
      </header>

      {(sandboxError || provisioningRetryError) && (
        <div className="space-y-1 border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-800">
          {sandboxError && <p role="alert">{sandboxError}</p>}
          {provisioningRetryError && <p role="alert">{provisioningRetryError}</p>}
        </div>
      )}

      {project.provision_status !== "READY" && (
        <section
          role="status"
          className={cn(
            "border-b px-4 py-3",
            project.provision_status === "FAILED"
              ? "border-rose-200 bg-rose-50"
              : "border-amber-200 bg-amber-50",
          )}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {project.provision_status === "FAILED" ? "Repository provisioning failed" : "Creating project sandbox and cloning repository"}
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                {project.provision_error ??
                  "CuteBots is preparing the sandbox and cloning the repository. Tasks will be available when cloning finishes."}
              </p>
            </div>
            {project.provision_status === "FAILED" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={provisioningRetryPending || !isSandboxRunning}
                onClick={onRetryProvisioning}
              >
                <RefreshCw className="mr-2 size-3.5" />
                {provisioningRetryPending ? "Retrying..." : "Retry repository clone"}
              </Button>
            )}
          </div>
        </section>
      )}

      <div
        ref={gridRef}
        className="grid min-h-0 min-w-[900px] flex-1 gap-px overflow-auto bg-zinc-200 [grid-template-columns:var(--workspace-grid)]"
        style={{
          "--workspace-grid": `${layout.filesShare}fr 6px ${layout.previewShare}fr 6px ${Math.max(1, 100 - layout.filesShare - layout.previewShare)}fr`,
          "--activity-share": `${layout.activityShare}fr`,
          "--tasks-share": `${100 - layout.activityShare}fr`,
        } as CSSProperties}
      >
        <div className="flex min-h-0 min-w-0 flex-col">
          <DashboardFilesPanel />
        </div>

        <div
          role="separator"
          aria-label="Resize Files and File preview panels"
          aria-orientation="vertical"
          aria-valuenow={Math.round(layout.filesShare)}
          aria-valuemin={14}
          aria-valuemax={38}
          tabIndex={0}
          onPointerDown={(event) => beginHorizontalResize(event, "first")}
          onPointerMove={moveHorizontalResize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onKeyDown={(event) => resizeWithKeyboard(event, "horizontal", "first")}
          className="flex cursor-col-resize touch-none items-center justify-center bg-zinc-200 hover:bg-lime-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-zinc-800"
        >
          <span className="h-8 w-0.5 rounded bg-zinc-500" />
        </div>

        <div className="flex min-h-0 min-w-0 flex-col">
          <DashboardFilePreviewPanel />
        </div>

        <div
          role="separator"
          aria-label="Resize File preview and Agent activity panels"
          aria-orientation="vertical"
          aria-valuenow={Math.round(layout.previewShare)}
          aria-valuemin={24}
          aria-valuemax={64}
          tabIndex={0}
          onPointerDown={(event) => beginHorizontalResize(event, "second")}
          onPointerMove={moveHorizontalResize}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          onKeyDown={(event) => resizeWithKeyboard(event, "horizontal", "second")}
          className="flex cursor-col-resize touch-none items-center justify-center bg-zinc-200 hover:bg-lime-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-zinc-800"
        >
          <span className="h-8 w-0.5 rounded bg-zinc-500" />
        </div>

        <div className="grid min-h-0 min-w-0 gap-px bg-zinc-200" style={{ gridTemplateRows: "minmax(0, var(--activity-share)) 6px minmax(0, var(--tasks-share))" }}>
          <div className="flex min-h-0 min-w-0 flex-col">
            <DashboardActivityPanel />
          </div>

          <div
            role="separator"
            aria-label="Resize Agent activity and Tasks panels"
            aria-orientation="horizontal"
            aria-valuenow={Math.round(layout.activityShare)}
            aria-valuemin={25}
            aria-valuemax={75}
            tabIndex={0}
            onPointerDown={beginVerticalResize}
            onPointerMove={moveVerticalResize}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onKeyDown={(event) => resizeWithKeyboard(event, "vertical")}
            className="flex cursor-row-resize touch-none items-center justify-center bg-zinc-200 hover:bg-lime-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-zinc-800"
          >
            <span className="h-0.5 w-8 rounded bg-zinc-500" />
          </div>

          <div className="flex min-h-0 min-w-0 flex-col">
            <DashboardTasksPanel />
          </div>
        </div>
      </div>
    </div>
  )
})

"use client"

import { FileText } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { DashboardPanel } from "@/components/dashboard-primitives"
import { useDashboardFiles, useDashboardWorkspace } from "@/contexts/dashboard-context"

export function DashboardFilesPanel() {
  const { project } = useDashboardWorkspace()
  const { files, filesLoading, filesError, selectedFile, onSelectFile } = useDashboardFiles()
  if (!project) return null

  const sandboxRunning = project.sandbox_status === "RUNNING"
  const provisionReady = project.provision_status === "READY"

  return (
    <DashboardPanel
      title="Files"
      action={<span className="text-[10px] text-zinc-400">{files.length}</span>}
      className="max-h-72 lg:max-h-none"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!sandboxRunning && <p className="p-2 text-xs text-zinc-500">Start the sandbox to browse files.</p>}
        {sandboxRunning && !provisionReady && <p className="p-2 text-xs text-zinc-500">Files are available after repository cloning completes.</p>}
        {sandboxRunning && provisionReady && filesLoading && <p className="p-2 text-xs text-zinc-500">Loading files...</p>}
        {filesError && <p className="p-2 text-xs text-rose-700">{filesError}</p>}
        {files.map((file) => {
          const name = file.replaceAll("\\", "/").split("/").at(-1) ?? file

          return (
            <Button
              key={file}
              type="button"
              variant="ghost"
              size="default"
              onClick={() => onSelectFile(file)}
              className={cn(
                "h-auto w-full justify-start gap-2 rounded-none px-2 py-1.5 text-left font-mono text-xs font-normal",
                selectedFile === file ? "bg-lime-100 text-zinc-900" : "text-zinc-600 hover:bg-zinc-100",
              )}
            >
              <FileText className="size-3.5 shrink-0" />
              {name}
            </Button>
          )
        })}
        {!files.length && !filesLoading && <p className="p-2 text-xs text-zinc-500">No files in this workspace.</p>}
      </div>
    </DashboardPanel>
  )
}

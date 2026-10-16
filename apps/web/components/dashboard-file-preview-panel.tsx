"use client"

import { DashboardPanel } from "@/components/dashboard-primitives"
import { useDashboardFiles } from "@/contexts/dashboard-context"

export function DashboardFilePreviewPanel() {
  const { selectedFile, fileLoading, fileError, fileContent } = useDashboardFiles()

  return (
    <DashboardPanel
      title={selectedFile?.split(/[\\/]/).at(-1) ?? "File preview"}
      className="min-h-[340px] lg:min-h-0"
    >
      {selectedFile ? (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-5 text-zinc-700">
          {fileLoading ? "Loading..." : fileError ?? fileContent}
        </pre>
      ) : (
        <div className="grid flex-1 place-items-center p-6 text-sm text-zinc-500">
          Choose a file to inspect it.
        </div>
      )}
    </DashboardPanel>
  )
}

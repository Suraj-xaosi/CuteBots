"use client"

import { useState } from "react"
import { FolderOpen } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { FileDialog } from "@/components/dashboard/file-dialog"
import { useSelectedProjectId } from "@/hooks/use-selection"

export function FilesButton() {
  const projectId = useSelectedProjectId()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button
        variant="outline"
        aria-label="Files"
        className="shrink-0"
        disabled={!projectId}
        onClick={() => setOpen(true)}
      >
        <FolderOpen />
        <span className="hidden @md:inline">Files</span>
      </Button>
      {projectId ? <FileDialog projectId={projectId} open={open} onOpenChange={setOpen} /> : null}
    </>
  )
}
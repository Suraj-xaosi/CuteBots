"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { ProjectDialog } from "@/components/dashboard/project-dialog"

// The button owns its dialog's open state: nobody else needs it, so nothing
// is lifted up. The label collapses to an icon when the header is narrow
// (@md is relative to the PanelHeader this sits in).
export function AddProjectButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="outline" aria-label="Add project" className="shrink-0" onClick={() => setOpen(true)}>
        <Plus />
        <span className="hidden @md:inline">Add project</span>
      </Button>
      <ProjectDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
"use client"

import { useState } from "react"
import { Settings2 } from "lucide-react"
import { IconButton } from "@/components/dashboard/layout/icon-button"
import { SettingsDialog } from "@/components/dashboard/settings-dialog"
import { useSelectedProjectId } from "@/hooks/use-selection"

// Opens the same SettingsDialog as before (provider, model, URL, API key,
// Tavily key, repository token) for the selected project. The button owns the
// dialog's open state.
export function SettingsButton() {
  const projectId = useSelectedProjectId()
  const [open, setOpen] = useState(false)

  if (!projectId) return null

  return (
    <>
      <IconButton label="Project settings" onClick={() => setOpen(true)}>
        <Settings2 />
      </IconButton>
      <SettingsDialog projectId={projectId} open={open} onOpenChange={setOpen} />
    </>
  )
}
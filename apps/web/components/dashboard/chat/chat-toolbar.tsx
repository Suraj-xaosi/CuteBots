import { PanelHeader } from "@/components/dashboard/layout/panel"
import { AddProjectButton } from "./add-project-button"
import { FilesButton } from "./files-button"
import { ProjectSelect } from "./project-select"

// Order from the design: Add project and Files sit next to each other, the
// project picker is last. Nothing here has props; each control is its own
// small component.
export function ChatToolbar() {
  return (
    <PanelHeader>
      <AddProjectButton />
      <FilesButton />
      <ProjectSelect />
    </PanelHeader>
  )
}
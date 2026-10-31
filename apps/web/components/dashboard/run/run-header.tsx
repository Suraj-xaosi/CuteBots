import { PanelHeader } from "@/components/dashboard/layout/panel"
import { RunStatusMenu } from "./run-status-menu"
import { SettingsButton } from "./settings-button"

// One header, right aligned: status menu and settings. It needs roughly
// 200px, far below the panel's minimum width, so it can never clip.
export function RunHeader({ conversationId }: { conversationId: string | null }) {
  return (
    <PanelHeader>
      <RunStatusMenu conversationId={conversationId} />
      <SettingsButton />
    </PanelHeader>
  )
}
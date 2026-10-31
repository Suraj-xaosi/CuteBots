import { Bot } from "lucide-react"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@workspace/ui/components/resizable"
import { TooltipProvider } from "@workspace/ui/components/tooltip"
import { ChatPanel } from "./chat/chat-panel"
import { COLLAPSED_SIZE, PANELS } from "./layout/layout-config"
import { ProjectGate } from "./project-gate"
import { RunPanel } from "./run/run-panel"
import { RunStreamBridge } from "./run-stream-bridge"
import { BrandHeader } from "./sidebar/brand-header"
import { ConversationSidebar } from "./sidebar/conversation-sidebar"

// Server component, no props, no hooks: only the shape of the screen.
//   - no Topbar any more: every control moved into the panel it belongs to
//   - the page never scrolls; only each panel's body does
//   - handles are transparent 8px gaps, so panels read as separate cards
//     but stay draggable
const handleClass = "w-2 cursor-col-resize bg-transparent transition-colors hover:bg-muted"

export function Workspace() {
  return (
    <TooltipProvider>
      <main className="h-dvh overflow-hidden p-2">
        <ProjectGate empty={<EmptyWorkspace />}>
          <ResizablePanelGroup orientation="horizontal" className="h-full">
            <ResizablePanel {...PANELS.sidebar} collapsible collapsedSize={COLLAPSED_SIZE}>
              <div className="flex h-full min-h-0 min-w-0 flex-col gap-2 overflow-hidden">
                <BrandHeader />
                <ConversationSidebar />
              </div>
            </ResizablePanel>
            <ResizableHandle className={handleClass} />
            <ResizablePanel {...PANELS.chat}>
              <ChatPanel />
            </ResizablePanel>
            <ResizableHandle className={handleClass} />
            <ResizablePanel {...PANELS.run} collapsible collapsedSize={COLLAPSED_SIZE}>
              <RunPanel />
            </ResizablePanel>
          </ResizablePanelGroup>
          <RunStreamBridge />
        </ProjectGate>
      </main>
    </TooltipProvider>
  )
}

function EmptyWorkspace() {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Bot />
        </EmptyMedia>
        <EmptyTitle>Your coding workspace</EmptyTitle>
        <EmptyDescription>
          Add a GitHub project to create its sandbox and start a conversation with your agent.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
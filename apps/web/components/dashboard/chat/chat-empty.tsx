import { MessageSquare } from "lucide-react"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"

// w-full max-w-md: a fixed, definite width. It never sizes itself from its
// content, which is what made the old empty card collapse into a thin strip.
export function ChatEmpty() {
  return (
    <Empty className="w-full max-w-md">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessageSquare />
        </EmptyMedia>
        <EmptyTitle>Hi... wanna cook today ?</EmptyTitle>
        <EmptyDescription>Ask CuteBots to cook something in your repo.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
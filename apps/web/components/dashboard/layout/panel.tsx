import type { ComponentProps } from "react"
import { cn } from "@workspace/ui/lib/utils"

// The size rules for every panel live in these three primitives and nowhere
// else. Components are built from them, so no component can reintroduce a
// collapsed card or an overflowing row on its own.
//
//   Panel        fills its resizable slot, never wider than the slot
//   PanelHeader  fixed height, never scrolls, is a container for @md/@sm
//                variants (labels collapse to icons when the panel is narrow)
//   PanelBody    takes the rest of the height and is the ONLY thing that scrolls
//
// No Card / CardHeader here on purpose: CardHeader is a container-query
// container, which collapses to zero width inside shrink-to-fit parents.

export function Panel({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-background",
        className
      )}
      {...props}
    />
  )
}

export function PanelHeader({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      className={cn("@container flex h-14 shrink-0 items-center justify-end gap-2 px-3", className)}
      {...props}
    />
  )
}

export function PanelBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]", className)}
      {...props}
    />
  )
}
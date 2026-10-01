import type { ReactNode } from "react"

import { Badge } from "@workspace/ui/components/badge"
import { Card, CardContent, CardHeader } from "@workspace/ui/components/card"
import { cn } from "@workspace/ui/lib/utils"

function statusTone(status: string): string {
  switch (status) {
    case "RUNNING":
      return "bg-emerald-50 text-emerald-800"
    case "PENDING":
      return "bg-amber-50 text-amber-800"
    case "PAUSED":
      return "bg-sky-50 text-sky-800"
    case "DONE":
      return "bg-lime-50 text-lime-900"
    case "FAILED":
      return "bg-rose-50 text-rose-800"
    default:
      return "bg-zinc-100 text-zinc-700"
  }
}

export function DashboardStatus({ value }: { value: string }) {
  return (
    <Badge
      className={cn(
        "rounded px-2 py-1 text-[11px] font-semibold",
        statusTone(value)
      )}
    >
      {value.toLowerCase()}
    </Badge>
  )
}

export function DashboardPanel({
  title,
  action,
  children,
  className,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("flex min-h-0 flex-col", className)}>
      <Card className="h-full min-h-0 flex-1 gap-0 rounded-none border border-zinc-200 bg-white py-0 text-zinc-900 shadow-none ring-0">
        <CardHeader className="flex min-h-11 grid-cols-none items-center justify-between gap-0 rounded-none border-b border-zinc-200 px-3 py-0">
          <h2 className="text-xs font-semibold text-zinc-600 uppercase">
            {title}
          </h2>
          {action}
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col px-0">
          {children}
        </CardContent>
      </Card>
    </section>
  )
}

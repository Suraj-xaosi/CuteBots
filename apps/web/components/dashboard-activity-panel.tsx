"use client"

import { DashboardPanel } from "@/components/dashboard-primitives"
import { useDashboardTasks } from "@/contexts/dashboard-context"

export function DashboardActivityPanel() {
  const { stream } = useDashboardTasks()

  return (
    <DashboardPanel
      title="Agent activity"
      action={<span className="text-[10px] text-zinc-500">{stream.status}</span>}
    >
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {stream.events.slice().reverse().map((event) => (
          <article key={event.id} className="border-l-2 border-lime-500 bg-zinc-50 px-2.5 py-2">
            <p className="text-[10px] font-semibold uppercase text-zinc-500">{event.type}</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-700">{event.content}</p>
          </article>
        ))}
        {!stream.events.length && <p className="text-xs text-zinc-500">Select a task to view its live events.</p>}
      </div>
    </DashboardPanel>
  )
}

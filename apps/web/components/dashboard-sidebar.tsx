"use client"

import { memo } from "react"
import { Plus, Settings } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { useDashboardWorkspace } from "@/contexts/dashboard-context"

export const DashboardSidebar = memo(function DashboardSidebar() {
  const { projects, project: selectedProject, onSelectProject, onNewProject, onOpenSettings } = useDashboardWorkspace()
  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-zinc-200 bg-white lg:w-64 lg:border-r lg:border-b-0">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-4">
        <div>
          <p className="text-[10px] font-bold uppercase text-lime-700">Local coding agent</p>
          <h1 className="mt-1 text-lg font-semibold">CuteBots</h1>
        </div>
        <Button variant="outline" size="icon" title="Configure model" aria-label="Configure model" onClick={onOpenSettings}>
          <Settings className="size-4" />
        </Button>
      </div>
      <div className="flex items-center justify-between px-3 pt-4">
        <h2 className="text-xs font-semibold uppercase text-zinc-500">Projects</h2>
        <Button variant="ghost" size="icon" title="New project" aria-label="New project" onClick={onNewProject}>
          <Plus className="size-4" />
        </Button>
      </div>
      <nav className="flex gap-2 overflow-x-auto p-3 lg:flex-1 lg:flex-col lg:overflow-y-auto">
        {projects.map((project) => {
          const isSelected = selectedProject?.id === project.id

          return (
            <Button
              key={project.id}
              type="button"
              variant="ghost"
              size="default"
              onClick={() => onSelectProject(project.id)}
              className={cn(
                "h-auto min-w-44 justify-start rounded-none border px-3 py-2 text-left whitespace-normal lg:min-w-0",
                isSelected
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white hover:bg-zinc-50",
              )}
            >
              <span className="block truncate text-sm font-medium">{project.name}</span>
              <span className={cn("mt-1 block truncate text-[11px]", isSelected ? "text-zinc-300" : "text-zinc-500")}>
                {project.repo_url}
              </span>
            </Button>
          )
        })}
        {!projects.length && <p className="px-2 py-3 text-sm text-zinc-500">No projects yet.</p>}
      </nav>
      <div className="hidden border-t border-zinc-200 p-3 text-xs text-zinc-500 lg:block">
        Sandbox code is isolated in Docker.
      </div>
    </aside>
  )
})

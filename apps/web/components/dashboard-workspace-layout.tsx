"use client"

import { FolderGit2, Plus } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { DashboardDialogs } from "@/components/dashboard-dialogs"
import { DashboardProjectContent } from "@/components/dashboard-project-content"
import { DashboardSidebar } from "@/components/dashboard-sidebar"
import { useDashboardWorkspace } from "@/contexts/dashboard-context"

export function DashboardWorkspaceLayout() {
  const { project, onNewProject } = useDashboardWorkspace()

  return (
    <main className="min-h-screen bg-zinc-100 text-zinc-900 lg:h-screen lg:overflow-hidden">
      <div className="mx-auto flex min-h-screen max-w-[1900px] flex-col lg:h-screen lg:flex-row">
        <DashboardSidebar />
        {project ? (
          <DashboardProjectContent />
        ) : (
          <section className="grid min-h-[70vh] flex-1 place-items-center p-6">
            <div className="max-w-md text-center">
              <FolderGit2 className="mx-auto size-9 text-lime-700" />
              <h2 className="mt-4 text-xl font-semibold">Create your first project</h2>
              <p className="mt-2 text-sm text-zinc-600">
                Connect a GitHub repository to create an isolated workspace and start delegating coding tasks.
              </p>
              <Button className="mt-5" onClick={onNewProject}>
                <Plus className="mr-2 size-4" />
                New project
              </Button>
            </div>
          </section>
        )}
      </div>
      <DashboardDialogs />
    </main>
  )
}

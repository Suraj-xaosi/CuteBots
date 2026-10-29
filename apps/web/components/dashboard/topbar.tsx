"use client"

import { useState } from "react"
import { Bot, Plus, Settings2 } from "lucide-react"
import { useProjectContext } from "@/components/project-provider"
import { ProjectDialog } from "./project-dialog"
import { SettingsDialog } from "./settings-dialog"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import {
  Card,
  CardContent,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

export function Topbar({
  onProjectChange,
  onProjectCreated,
}: {
  onProjectChange: (projectId: string) => void
  onProjectCreated: (projectId: string, setupError: string | null) => void
}) {
  const { projects, selectedProjectId, selectProject } = useProjectContext()
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const active = projects.find((project) => project.id === selectedProjectId)

  const select = (id: string) => {
    selectProject(id)
    onProjectChange(id)
  }
  const created = (id: string, setupError: string | null) => {
    setNewProjectOpen(false)
    onProjectCreated(id, setupError)
  }

  return (
    <Card className="rounded-none border-x-0 border-t-0 py-0">
      <CardContent className="flex min-h-16 flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Bot className="text-primary" />
          CuteBots
        </CardTitle>
        <CardContent className="flex items-center gap-2 p-0">
          {projects.length ? (
            <Select value={selectedProjectId ?? ""} onValueChange={(value) => value && select(value)}>
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Choose a project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button variant="outline" onClick={() => setNewProjectOpen(true)}>
            <Plus />
            Add project
          </Button>
          {active ? (
            <>
              <Badge variant={active.sandboxStatus === "RUNNING" ? "secondary" : "outline"}>
                Sandbox {active.sandboxStatus.toLowerCase()}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Project settings"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings2 />
              </Button>
            </>
          ) : null}
        </CardContent>
      </CardContent>
      <ProjectDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
        onCreated={created}
      />
      {active ? (
        <SettingsDialog
          projectId={active.id}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      ) : null}
    </Card>
  )
}

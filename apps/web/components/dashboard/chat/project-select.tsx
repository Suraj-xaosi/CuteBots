"use client"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { useProjects } from "@/hooks/use-projects"
import { useSelectedProject } from "@/hooks/use-selection"
import { useAppDispatch } from "@/store/hooks"
import { workspaceActions } from "@/store/workspace-slice"

// Reads the list from the cache, writes the choice to Redux. Fixed width cap
// plus shrink/min-w-0: it gives up space before the buttons next to it do.
export function ProjectSelect() {
  const dispatch = useAppDispatch()
  const { data: projects } = useProjects()
  const active = useSelectedProject()

  if (!projects?.length) return null

  return (
    <Select
      value={active?.id ?? ""}
      onValueChange={(id) => {
        if (id) dispatch(workspaceActions.projectSelected(id))
      }}
    >
      <SelectTrigger aria-label="Project" className="w-40 min-w-0 shrink">
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
  )
}
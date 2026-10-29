"use client"

import { createContext, useCallback, useContext, useMemo, useState } from "react"
import type { ProjectListItem } from "@workspace/types"

const ProjectContext = createContext<{
  projects: ProjectListItem[]
  selectedProjectId: string | null
  activeConversationId: string | null
  setActiveConversationId: (id: string | null) => void
  selectProject: (id: string) => void
  replaceProjects: (projects: ProjectListItem[]) => void
} | null>(null)

export function ProjectProvider({
  children,
  initialProjects,
  initialConversationId,
}: {
  children: React.ReactNode
  initialProjects: ProjectListItem[]
  initialConversationId: string | null
}) {
  const [projects, setProjects] = useState(initialProjects)
  const [selectedProjectId, setSelectedProjectId] = useState(
    initialProjects[0]?.id ?? null
  )
  const [activeConversation, setActiveConversation] = useState<{
    projectId: string
    id: string
  } | null>(
    initialConversationId && initialProjects[0]
      ? { projectId: initialProjects[0].id, id: initialConversationId }
      : null
  )

  const selectProject = useCallback(
    (id: string) => {
      if (projects.some((project) => project.id === id)) {
        setSelectedProjectId(id)
      }
    },
    [projects]
  )
  const setActiveConversationId = useCallback(
    (id: string | null) => {
      setActiveConversation(
        id && selectedProjectId ? { projectId: selectedProjectId, id } : null
      )
    },
    [selectedProjectId]
  )
  const replaceProjects = useCallback((nextProjects: ProjectListItem[]) => {
    setProjects(nextProjects)
    setSelectedProjectId((current) =>
      nextProjects.some((project) => project.id === current)
        ? current
        : (nextProjects[0]?.id ?? null)
    )
  }, [])

  const value = useMemo(
    () => ({
      projects,
      selectedProjectId,
      activeConversationId:
        activeConversation?.projectId === selectedProjectId
          ? activeConversation.id
          : null,
      setActiveConversationId,
      selectProject,
      replaceProjects,
    }),
    [
      projects,
      selectedProjectId,
      activeConversation,
      setActiveConversationId,
      selectProject,
      replaceProjects,
    ]
  )

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  )
}

export function useProjectContext() {
  const context = useContext(ProjectContext)
  if (!context) throw new Error("ProjectProvider is missing")
  return context
}

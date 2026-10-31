"use client"

import { useConversations } from "./use-Conversations"
import { useProjects } from "./use-projects"
import { useAppSelector } from "@/store/hooks"
import { selectActiveConversationId, selectSelectedProjectId } from "@/store/workspace-slice"

// Redux stores what the user chose. These hooks turn that into what is shown:
// if nothing is chosen yet (or the choice no longer exists), fall back to the
// first item. It is computed during render, so there is no "pick the first
// one" effect or handler anywhere.

export function useSelectedProjectId(): string | null {
  const stored = useAppSelector(selectSelectedProjectId)
  const { data: projects } = useProjects()

  if (!projects) return stored
  return projects.some((project) => project.id === stored) ? stored : (projects[0]?.id ?? null)
}

export function useSelectedProject() {
  const projectId = useSelectedProjectId()
  const { data: projects } = useProjects()
  return projects?.find((project) => project.id === projectId) ?? null
}

export function useActiveConversationId(): string | null {
  const projectId = useSelectedProjectId()
  const stored = useAppSelector(selectActiveConversationId)
  const { data: conversations } = useConversations(projectId)

  if (!conversations) return stored
  return conversations.some((item) => item.id === stored) ? stored : (conversations[0]?.id ?? null)
}
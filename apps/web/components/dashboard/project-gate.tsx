"use client"

import type { ReactNode } from "react"
import { TriangleAlert } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { useProjects } from "@/hooks/use-projects"
import { useSelectedProjectId } from "@/hooks/use-selection"

// The one place that answers "is there anything to show yet?".
// `empty` and `children` arrive from the server layout as ready-made
// elements, so this client component only chooses between them.
export function ProjectGate({ children, empty }: { children: ReactNode; empty: ReactNode }) {
  const projects = useProjects()
  const projectId = useSelectedProjectId()

  // Only a failure when there is nothing cached to show.
  if (!projects.data) {
    if (projects.isError) {
      return (
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TriangleAlert />
            </EmptyMedia>
            <EmptyTitle>Couldn&rsquo;t load your projects</EmptyTitle>
            <EmptyDescription>{projects.error?.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => void projects.refetch()}>
              Try again
            </Button>
          </EmptyContent>
        </Empty>
      )
    }
    // Same proportions as the real layout, so nothing jumps when data arrives.
    return (
      <div className="grid h-full grid-cols-[22fr_44fr_34fr] gap-2">
        <Skeleton className="h-full rounded-xl" />
        <Skeleton className="h-full rounded-xl" />
        <Skeleton className="h-full rounded-xl" />
      </div>
    )
  }

  if (!projectId) return empty
  return children
}
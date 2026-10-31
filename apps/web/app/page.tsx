import { HydrationBoundary } from "@tanstack/react-query"
import { Workspace } from "@/components/dashboard/workspace"
import { prefetchWorkspace } from "@/hooks/prefetch-workspace"
import { connection } from "next/server"

// Server component. It fetches on the server, hands the result to the client
// cache through HydrationBoundary, and renders the (server) layout. Nothing
// is passed down as props any more: every client component reads the cache.
export default async function WorkspacePage() {
   await connection()
  return (
    <HydrationBoundary state={await prefetchWorkspace()}>
      <Workspace />
    </HydrationBoundary>
  )
}
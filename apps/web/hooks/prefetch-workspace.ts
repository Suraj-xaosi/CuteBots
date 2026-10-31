
import { getQueryClient } from "./get-query-client"
import { conversationQuery, conversationsQuery, projectsQuery } from "./queries"
import { dehydrate, noop, type DehydratedState } from "@tanstack/react-query"

// Server only. Call from page.tsx and pass the result to <HydrationBoundary>.
//
// It prefetches exactly what the client would derive on first render:
// first project -> its first conversation -> that conversation's details.
// Redux starts as null/null and the selection hooks fall back to "first",
// so server and client agree and there is no loading flash on first paint.
//
// prefetchQuery swallows errors on purpose: if something fails here, the
// client query simply fetches again and shows its own error state.
export async function prefetchWorkspace(): Promise<DehydratedState> {
  const queryClient = getQueryClient()

  // query() throws on failure; .catch(noop) keeps prefetch best-effort.
  // The client refetches and shows its own error state if this fails.
  const projects = await queryClient.query(projectsQuery()).catch(noop)
  const projectId = projects?.[0]?.id ?? null

  if (projectId) {
    const conversations = await queryClient.query(conversationsQuery(projectId)).catch(noop)
    const conversationId = conversations?.[0]?.id ?? null
    if (conversationId) await queryClient.query(conversationQuery(conversationId)).catch(noop)
  }

  return dehydrate(queryClient)
}
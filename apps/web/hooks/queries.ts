import { queryOptions, skipToken } from "@tanstack/react-query"
import { listConversations, getConversation } from "@/lib/actions/conversations"
import { listProjects } from "@/lib/actions/projects"
import { getProjectCredentials } from "@/lib/actions/project-credentials"
import { getRunActivity } from "@/lib/actions/run-activity"
import { listProjectFiles, readProjectFile } from "@/lib/actions/sandbox"
import { queryKeys } from "./query-keys"
import { unwrap } from "./unwrap"

// One factory per query. The server page prefetches with these, client hooks
// read with these, and the stream writes into these keys. The key can never
// drift apart because it is only ever created here.
//
// Ids that may not exist yet (nothing selected) accept null and use skipToken,
// so no hook ever needs `enabled` plus a non-null assertion.

export const projectsQuery = () =>
  queryOptions({
    queryKey: queryKeys.projects(),
    queryFn: () => unwrap(listProjects()),
  })

export const conversationsQuery = (projectId: string | null) =>
  queryOptions({
    queryKey: queryKeys.conversations(projectId),
    queryFn: projectId === null ? skipToken : () => unwrap(listConversations(projectId)),
  })

export const conversationQuery = (conversationId: string | null) =>
  queryOptions({
    queryKey: queryKeys.conversation(conversationId),
    queryFn: conversationId === null ? skipToken : () => unwrap(getConversation(conversationId)),
  })

// staleTime Infinity: once loaded, only the stream (and explicit reconnect)
// changes this data. No surprise refetch on window focus replacing live items.
export const runActivityQuery = (runId: string | null) =>
  queryOptions({
    queryKey: queryKeys.runActivity(runId),
    queryFn: runId === null ? skipToken : () => unwrap(getRunActivity(runId)),
    staleTime: Infinity,
  })

// The agent edits files while the user looks, so these are always refetched.
export const projectDirectoryQuery = (projectId: string, path: string) =>
  queryOptions({
    queryKey: queryKeys.projectDirectory(projectId, path),
    queryFn: () => unwrap(listProjectFiles(projectId, path)),
    staleTime: 0,
  })

export const projectFileQuery = (projectId: string, path: string | null) =>
  queryOptions({
    queryKey: queryKeys.projectFile(projectId, path),
    queryFn: path === null ? skipToken : () => unwrap(readProjectFile(projectId, path)),
    staleTime: 0,
  })

export const projectCredentialsQuery = (projectId: string) =>
  queryOptions({
    queryKey: queryKeys.projectCredentials(projectId),
    queryFn: () => unwrap(getProjectCredentials(projectId)),
    staleTime: 0,
  })
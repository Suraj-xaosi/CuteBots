// Every key in the app is built here, and only here.
// Roots are deliberately distinct (no key is a prefix of another), so
// invalidating one thing can never accidentally invalidate something else.
export const queryKeys = {
  projects: () => ["projects"] as const,
  conversations: (projectId: string | null) => ["conversations", projectId] as const,
  conversation: (conversationId: string | null) => ["conversation", conversationId] as const,
  runActivity: (runId: string | null) => ["run-activity", runId] as const,
  projectDirectory: (projectId: string, path: string) =>
    ["project-directory", projectId, path] as const,
  projectFile: (projectId: string, path: string | null) =>
    ["project-file", projectId, path] as const,
  projectCredentials: (projectId: string) => ["project-credentials", projectId] as const,
}
// Every key in the app is built here, and only here.
// Resource roots can be invalidated without touching unrelated cached data.
export const queryKeys = {
  projects: () => ["projects"] as const,
  conversations: (projectId: string | null) =>
    ["conversations", projectId] as const,
  conversation: (conversationId: string | null) =>
    ["conversation", conversationId] as const,
  runActivity: (runId: string | null) => ["run-activity", runId] as const,
  projectDirectory: (projectId: string, path?: string) =>
    path === undefined
      ? (["project-directory", projectId] as const)
      : (["project-directory", projectId, path] as const),
  projectFile: (projectId: string, path?: string | null) =>
    path === undefined
      ? (["project-file", projectId] as const)
      : (["project-file", projectId, path] as const),
  projectCredentials: (projectId: string) =>
    ["project-credentials", projectId] as const,
  sandboxStatus: (projectId: string) => ["sandbox-status", projectId] as const,
}

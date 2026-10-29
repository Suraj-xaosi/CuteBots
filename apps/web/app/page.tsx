import { Suspense } from "react"
import { ProjectProvider } from "@/components/project-provider"
import { Workspace } from "@/components/dashboard/workspace"
import { DashboardLoading } from "@/components/dashboard/loading"
import { listProjects } from "@/lib/actions/projects"
import { listConversations } from "@/lib/actions/conversations"
import { getConversation } from "@/lib/actions/conversations"
import { getRunActivity } from "@/lib/actions/run-activity"

export const dynamic = "force-dynamic"

export default function Page() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <Dashboard />
    </Suspense>
  )
}

async function Dashboard() {
  const projectResult = await listProjects()
  const projects = projectResult.ok ? projectResult.data : []
  const firstProject = projects[0]
  const conversationResult = firstProject
    ? await listConversations(firstProject.id)
    : null
  const conversations =
    conversationResult?.ok ? conversationResult.data : []
  const active = conversations[0]
    ? await getConversation(conversations[0].id)
    : null
  const runId = active?.ok ? active.data.runs[0]?.id : null
  const activity = runId ? await getRunActivity(runId) : null

  return (
    <ProjectProvider
      initialProjects={projects}
      initialConversationId={active?.ok ? active.data.id : null}
    >
      <Workspace
        initialConversations={conversations}
        initialConversation={active?.ok ? active.data : null}
        initialActivity={activity?.ok ? activity.data : []}
        initialError={
          projectResult.ok
            ? conversationResult && !conversationResult.ok
              ? conversationResult.error
              : null
            : projectResult.error
        }
      />
    </ProjectProvider>
  )
}

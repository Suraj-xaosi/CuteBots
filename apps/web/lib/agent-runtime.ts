import 'server-only'

import {
  AgentLoop,
  AgentLoopManager,
  ContainerManager,
  HumanReplyInbox,
  LLMClient,
  ToolRegistry,
  UIChannel,
} from '@workspace/core'
import { prisma } from '@workspace/db'
import { AgentRunStatus, ErrorCode, isProviderName, type Result } from '@workspace/types'
import { decrypt, readProjectCredentials } from './credentials'
import { persistence } from './agent-persistence'
import { RunEventBroker } from './run-event-broker'

export const events = new RunEventBroker(persistence)
export const replies = new HumanReplyInbox()
export const containers = ContainerManager.getInstance()

export async function getSandbox(projectId: string): Promise<Result<any>> {
  const cleanId = projectId.trim()
  if (!cleanId) {
    return { ok: false, error: 'Project id is missing', code: ErrorCode.TASK_NOT_FOUND }
  }

  const sandbox = containers.get(cleanId)
  if (sandbox.ok) return sandbox

  const recovered = await containers.recover(cleanId)
  if (recovered.ok) return containers.get(cleanId)

  return containers.create(cleanId)
}

export const runs = AgentLoopManager.getInstance((context) => {
  let loop: AgentLoop | undefined

  return {
    async run() {
      try {
        const [project, credentials, sandboxResult] = await Promise.all([
          prisma.project.findUnique({ where: { id: context.projectId } }),
          readProjectCredentials(context.projectId),
          getSandbox(context.projectId),
        ])

        if (!project || !sandboxResult.ok) return
        if (!credentials) return
        if (!isProviderName(credentials.provider)) return

        const sandbox = sandboxResult.data as any
        const llm = new LLMClient({
          provider: credentials.provider,
          apiKey: credentials.apiKey,
          model: credentials.model,
          baseUrl: credentials.baseUrl,
        })

        const channel = new UIChannel(
          context.runId,
          persistence,
          (event) => events.publish(event),
          replies
        )

        const tools = new ToolRegistry({
          humanInteraction: channel,
          ...(project.repo_url
            ? {
                githubPush: {
                  token: project.github_token ? decrypt(project.github_token) : undefined,
                  repositoryUrl: project.repo_url,
                  branchName: context.branchName ?? `agent/${context.runId}`,
                },
              }
            : {}),
          ...(credentials.tavilyApiKey ? { tavilyApiKey: credentials.tavilyApiKey } : {}),
        })

        loop = new AgentLoop(persistence, llm, tools, sandbox, channel)
        await loop.run(context)
      } catch (error) {
        console.error('Agent run crashed', { runId: context.runId, error })

        await persistence
          .updateRunStatus(
            context.runId,
            AgentRunStatus.FAILED,
            error instanceof Error ? error.message : 'Run crashed unexpectedly'
          )
          .catch(() => null)
      }
    },

    stop() {
      loop?.stop()
    },
  }
})


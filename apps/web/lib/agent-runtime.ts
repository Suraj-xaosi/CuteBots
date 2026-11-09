import 'server-only'

import {
  AgentLoop,
  AgentLoopManager,
  ContainerManager,
  HumanReplyInbox,
  LLMClient,
  ToolRegistry,
  UIChannel,
  isCommandFailure,
  type AgentExecutor,
  type AgentRunContext,
  type Sandbox,
} from '@workspace/core'
import { prisma } from '@workspace/db'
import { AgentRunStatus, ErrorCode, isProviderName, isTerminalAgentRunStatus, type Result } from '@workspace/types'
import { decrypt, hasUsableCredentials, readProjectCredentials } from './credentials'
import { persistence } from './agent-persistence'
import { RunEventBroker } from './run-event-broker'

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/

// ---------------------------------------------------------------------------
// ONE shared runtime per server process.
// Next.js can load this module more than once (hot reload, separate bundles for
// server actions and route handlers). Plain `export const x = new X()` would then
// give each copy its own broker / manager / inbox and they would stop seeing each
// other. Keeping them on globalThis guarantees a single instance. (Lesson 6 shows why
// this matters for live streaming.)
// ---------------------------------------------------------------------------
const globalForRuntime = globalThis as unknown as {
  __cutebotsRuntime?: ReturnType<typeof createRuntime>
}
const runtime = (globalForRuntime.__cutebotsRuntime ??= createRuntime())

export const events = runtime.events
export const replies = runtime.replies
export const containers = runtime.containers
export const runs = runtime.runs

function createRuntime() {
  const events = new RunEventBroker(persistence)
  const replies = new HumanReplyInbox()
  const containers = ContainerManager.getInstance()
  const runs = AgentLoopManager.getInstance((context) => createExecutor(context, { events, replies }))
  return { events, replies, containers, runs }
}

export async function getSandbox(projectId: string): Promise<Result<Sandbox>> {
  const cleanId = projectId.trim()
  if (!cleanId) return { ok: false, error: 'Project id is missing', code: ErrorCode.TASK_NOT_FOUND }

  const sandbox = containers.get(cleanId)
  if (sandbox.ok) return sandbox

  const recovered = await containers.recover(cleanId)
  if (recovered.ok) return containers.get(cleanId)

  return containers.create(cleanId)
}

// Make sure the sandbox is on the run's working branch (create it if needed).
// Returns a problem string, or null when everything is fine.
async function ensureWorkingBranch(sandbox: Sandbox, branchName: string): Promise<string | null> {
  if (!BRANCH_PATTERN.test(branchName) || branchName.split('/').some((part) => part === '.' || part === '..')) {
    return `Working branch name "${branchName}" is not valid.`
  }

  // branchName is validated above, so single quotes are safe here.
  const result = await sandbox.exec(
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0; ` +
      `git checkout '${branchName}' >/dev/null 2>&1 || git checkout -b '${branchName}'`
  )
  if (!result.ok) return result.error
  if (isCommandFailure(result.data)) return result.data
  return null
}

function createExecutor(
  context: AgentRunContext,
  deps: { events: RunEventBroker; replies: HumanReplyInbox }
): AgentExecutor {
  let loop: AgentLoop | undefined
  // Cancel can arrive while we are still preparing (before `loop` exists). Remember it.
  let stopped = false

  // Log a line for the UI (persisted first, then broadcast), never throws.
  const note = async (type: 'warn' | 'error', content: string) => {
    try {
      const saved = await persistence.appendRunLog({ runId: context.runId, type, content })
      if (saved.ok) deps.events.publish(saved.data)
    } catch (error) {
      console.error('Unable to write run note', { runId: context.runId, error })
    }
  }

  // The ONLY way this executor ends a run unsuccessfully: say why, then go terminal.
  const failRun = async (reason: string) => {
    await note('error', reason)
    await persistence.updateRunStatus(context.runId, AgentRunStatus.FAILED, reason).catch(() => null)
  }

  return {
    async run() {
      try {
        const [project, credentials, sandboxResult] = await Promise.all([
          prisma.project.findUnique({ where: { id: context.projectId } }),
          readProjectCredentials(context.projectId),
          getSandbox(context.projectId),
        ])

        // Every early exit used to be a silent `return` that left the run QUEUED forever.
        if (!project) return void (await failRun('Project not found'))
        if (!sandboxResult.ok) return void (await failRun(`Sandbox unavailable: ${sandboxResult.error}`))
        if (!credentials || !hasUsableCredentials(credentials) || !isProviderName(credentials.provider)) {
          return void (await failRun('Provider credentials are missing or invalid. Check project settings.'))
        }

        const sandbox = sandboxResult.data as Sandbox
        const branchName = context.branchName ?? `agent/${context.conversationId}`

        const branchProblem = await ensureWorkingBranch(sandbox, branchName)
        if (branchProblem) {
          await note('warn', `Could not switch to the working branch: ${branchProblem}`)
        }

        const llm = new LLMClient({
          provider: credentials.provider,
          apiKey: credentials.apiKey,
          model: credentials.model,
          baseUrl: credentials.baseUrl,
        })

        const channel = new UIChannel(
          context.runId,
          persistence,
          (event) => deps.events.publish(event),
          deps.replies
        )

        const tools = new ToolRegistry({
          humanInteraction: channel,
          ...(project.repo_url
            ? {
                githubPush: {
                  token: project.github_token ? decrypt(project.github_token) : undefined,
                  repositoryUrl: project.repo_url,
                  branchName,
                },
              }
            : {}),
          ...(credentials.tavilyApiKey ? { tavilyApiKey: credentials.tavilyApiKey } : {}),
        })

        loop = new AgentLoop(persistence, llm, tools, sandbox, channel)
        if (stopped) loop.stop()
        await loop.run(context)
      } catch (error) {
        console.error('Agent run crashed', { runId: context.runId, error })
        await failRun(error instanceof Error ? error.message : 'Run crashed unexpectedly')
      } finally {
        // Safety net: whatever happened above, a run must never stay non-terminal
        // after its executor has finished. (This is what prevents zombie runs.)
        try {
          const row = await prisma.agentRun.findUnique({
            where: { id: context.runId },
            select: { status: true },
          })
          if (row && !isTerminalAgentRunStatus(row.status)) {
            await failRun('Run ended without a final status')
          }
        } catch (error) {
          console.error('Run safety net failed', { runId: context.runId, error })
        }
      }
    },

    stop() {
      stopped = true
      loop?.stop()
    },
  }
}
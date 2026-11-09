'use server'

import { prisma } from '@workspace/db'
import { redactTextSecrets } from '@workspace/core'
import { AgentRunStatus, ErrorCode, type ActionResult, type RunDetails, isTerminalAgentRunStatus } from '@workspace/types'
import { z } from 'zod'
import { hasUsableCredentials, readProjectCredentials } from '../credentials'
import { persistence } from '../agent-persistence'
import { forceFinishRun, waitForRunToFinish } from '../run-control'
import { provisionSandbox } from '../sandbox-service'
import { containers, replies, runs } from '../agent-runtime'
import { actionFailure } from '../action-utils'

const CANCEL_GRACE_MS = 3_000

const messageBodySchema = z.string().trim().min(1).max(20_000)




// ---------------------------------------------------------------------------
// Starting a run = 4 steps, in this order:
//   1. cheap checks   (busy? credentials?)
//   2. provision      (sandbox ready; slow, singleflight)
//   3. CLAIM          (one DB transaction: message + run + project lock)
//   4. START          (hand the run to the in-memory agent manager)
// If step 4 fails we undo step 3, so a run is never left QUEUED with nobody running it.
// ---------------------------------------------------------------------------

class RunStartError extends Error {
  code: ErrorCode
  constructor(message: string, code: ErrorCode = ErrorCode.TOOL_EXECUTION_FAILED) {
    super(message)
    this.code = code
  }
}

type RunSource = { content: string } | { messageId?: string }

// The in-memory manager clears itself a few ms AFTER the DB says the previous run
// is finished (two sources of truth). Retry briefly instead of failing a fast follow-up.
async function startWithRetry(context: Parameters<typeof runs.start>[0]) {
  for (let attempt = 0; ; attempt += 1) {
    const started = runs.start(context)
    if (started.ok || started.code !== ErrorCode.TASK_ALREADY_RUNNING || attempt >= 5) return started
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function launchRun(
  conversationId: string,
  source: RunSource
): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { project: true },
    })
    if (!conversation) throw new RunStartError('Conversation not found', ErrorCode.TASK_NOT_FOUND)
    const project = conversation.project

    // 1. cheap checks (the real guard is the claim in step 3)
    if (project.active_run_id) {
      throw new RunStartError(
        'The agent is already working on this project. Wait for it to finish, or cancel it.',
        ErrorCode.TASK_ALREADY_RUNNING
      )
    }

    if (!('content' in source)) {
      const pending = await prisma.message.findFirst({
        where: {
          conversation_id: conversationId,
          role: 'user',
          run_id: null,
          ...(source.messageId ? { id: source.messageId } : {}),
        },
        select: { id: true },
      })
      if (!pending) throw new RunStartError('No user message found', ErrorCode.TASK_NOT_FOUND)
    }

    const credentials = await readProjectCredentials(project.id)
    if (!hasUsableCredentials(credentials)) {
      throw new RunStartError('Add a provider and API key in project settings before starting.')
    }

    // 2. sandbox
    const sandbox = await provisionSandbox(project.id)
    if (!sandbox.ok) {
      throw new RunStartError(`Sandbox failed: ${sandbox.error}`, sandbox.code ?? ErrorCode.TOOL_EXECUTION_FAILED)
    }

    // 3. CLAIM: message + run + project lock in ONE transaction.
    //    If the project is busy, everything (including a new message) rolls back,
    //    so there is no orphan message and no orphan run.
    const run = await prisma.$transaction(async (tx) => {
      let messageId: string
      if ('content' in source) {
        const created = await tx.message.create({
          data: { conversation_id: conversationId, role: 'user', content: source.content },
        })
        messageId = created.id
      } else {
        const pending = await tx.message.findFirst({
          where: {
            conversation_id: conversationId,
            role: 'user',
            run_id: null,
            ...(source.messageId ? { id: source.messageId } : {}),
          },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        })
        if (!pending) throw new RunStartError('Add a user message before starting a run', ErrorCode.TASK_NOT_FOUND)
        messageId = pending.id
      }

      const created = await tx.agentRun.create({ data: { conversation_id: conversationId } })
      await tx.message.update({ where: { id: messageId }, data: { run_id: created.id } })

      // Compare-and-set: only succeeds if nobody else holds the project.
      const claimed = await tx.project.updateMany({
        where: { id: project.id, active_run_id: null },
        data: { active_run_id: created.id },
      })
      if (claimed.count !== 1) {
        throw new RunStartError(
          'The agent is already working on this project. Wait for it to finish, or cancel it.',
          ErrorCode.TASK_ALREADY_RUNNING
        )
      }

      await tx.conversation.update({ where: { id: conversationId }, data: { updated_at: new Date() } })
      return created
    })

    // 4. START. The working branch is the project's own setting if the user chose
    //    one, otherwise one stable branch per conversation. We no longer overwrite
    //    project.branch_name on every run.
    const branchName = project.branch_name?.trim() || `agent/${conversationId}`
    const started = await startWithRetry({
      runId: run.id,
      conversationId,
      projectId: project.id,
      branchName,
      projectContext: project.context,
    })

    if (!started.ok) {
      // Undo the claim: terminal status + project lock released.
      await persistence.updateRunStatus(run.id, AgentRunStatus.FAILED, started.error)
      throw new RunStartError(started.error, started.code)
    }

    return { ok: true, data: { id: run.id, status: 'QUEUED' } }
  } catch (error) {
    if (error instanceof RunStartError) return actionFailure('Start run', error.message, error.code)
    return actionFailure('Start run', error instanceof Error ? error.message : 'Unable to start run')
  }
}





// Kept for callers that already saved a message themselves (conversations.addMessage).
export async function startRun(
  conversationId: string,
  messageId?: string
): Promise<ActionResult<{ id: string; status: string }>> {
  return launchRun(conversationId, { messageId })
}





// Preferred entry point: saves the message AND starts the run atomically.
export async function submitMessage(
  conversationId: string,
  content: string
): Promise<ActionResult<{ id: string; status: string }>> {
  const parsed = messageBodySchema.safeParse(content)
  if (!parsed.success) return actionFailure('Submit message', 'Message must be 1 to 20,000 characters')

  return launchRun(conversationId, { content: parsed.data })
}





export async function getRun(runId: string): Promise<ActionResult<RunDetails>> {
  try {
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      include: { logs: { orderBy: { id: 'desc' }, take: 1 } },
    })

    if (!run) return actionFailure('Get run', 'Run not found', ErrorCode.TASK_NOT_FOUND)

    return {
      ok: true,
      data: {
        id: run.id,
        conversationId: run.conversation_id,
        status: run.status,
        summary: run.completion_summary ? redactTextSecrets(run.completion_summary) : null,
        failReason: run.fail_reason ? redactTextSecrets(run.fail_reason) : null,
        createdAt: run.created_at,
        startedAt: run.started_at,
        completedAt: run.completed_at,
        lastEventId: run.logs[0]?.id ?? 0,
      },
    }
  } catch (error) {
    return actionFailure('Get run', error instanceof Error ? error.message : 'Unable to load run')
  }
}





export async function replyToRun(runId: string, reply: string): Promise<ActionResult<{ status: string }>> {

  const parsed = messageBodySchema.safeParse(reply)
  if (!parsed.success) return actionFailure('Reply to run', 'Reply must be 1 to 20,000 characters')

  try {
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: { id: true, status: true, conversation_id: true },
    })

    if (!run) return actionFailure('Reply to run', 'Run not found', ErrorCode.TASK_NOT_FOUND)

    // Only a run that is actually waiting can take a reply.
    if (run.status !== 'WAITING_FOR_INPUT') {
      return actionFailure('Reply to run', 'The agent is not waiting for a reply right now')
    }

    const message = await prisma.message.create({
      data: {
        conversation_id: run.conversation_id,
        run_id: runId,
        role: 'user',
        content: parsed.data,
      },
    })

    const accepted = replies.submit(runId, parsed.data)
    if (!accepted.ok) {
      // The wait ended between our check and now (timeout / cancel): do not keep a reply the agent never saw.
      await prisma.message.delete({ where: { id: message.id } }).catch((error) => {
        console.error('Unable to roll back an unsent reply', { messageId: message.id, error })
      })
      return actionFailure('Reply to run', 'This run is no longer waiting for a reply')
    }

    return { ok: true, data: { status: 'accepted' } }
  }
  catch (error) {
    return actionFailure('Reply to run', error instanceof Error ? error.message : 'Unable to save reply')
  }
}





// Independent "Stop agent" button. Click = the run ends, guaranteed:
//   1. signal the loop (reaches the model call, the running tool and the ask_human wait)
//   2. kill commands still running in the sandbox for this run
//   3. wait briefly for a clean finish, otherwise force the end state
export async function cancelRun(runId: string): Promise<ActionResult<{ status: string }>> {
  try {
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      include: { conversation: { select: { project_id: true } } },
    })

    if (!run) return actionFailure('Cancel run', 'Run not found', ErrorCode.TASK_NOT_FOUND)
    if (isTerminalAgentRunStatus(run.status)) return actionFailure('Cancel run', 'Run has already finished')

    const projectId = run.conversation.project_id

    await runs.cancel(runId) // "not active in memory" is fine: step 3 covers it

    const sandbox = containers.get(projectId)
    if (sandbox.ok) await sandbox.data.cancelRunCommands(runId).catch(() => null)

    await waitForRunToFinish(runId, CANCEL_GRACE_MS)
    await forceFinishRun(runId, projectId)

    return { ok: true, data: { status: 'INTERRUPTED' } }
  }
  catch (error) {
    return actionFailure('Cancel run', error instanceof Error ? error.message : 'Unable to cancel run')
  }
}
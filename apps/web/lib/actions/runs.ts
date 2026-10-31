'use server'

import { prisma } from '@workspace/db'
import { redactTextSecrets } from '@workspace/core'
import { ErrorCode, type ActionResult, isTerminalAgentRunStatus } from '@workspace/types'
import { z } from 'zod'
import { readProjectCredentials } from '../credentials'
import { addMessage } from './conversations'
import { provisionSandbox } from '../sandbox-service'
import { containers, replies, runs } from '../agent-runtime'
import { actionFailure } from '../action-utils'

const messageBodySchema = z.string().trim().min(1)




export async function startRun(conversationId: string,messageId?: string): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const conversation = await prisma.conversation.findUnique(
      {
        where: { id: conversationId },
        include: { project: true },
      }
    )

    if (!conversation) return actionFailure('Start run', 'Conversation not found', ErrorCode.TASK_NOT_FOUND)

    const pendingMessage = await prisma.message.findFirst(
      {
        where: {
          conversation_id: conversationId,
          role: 'user',
          run_id: null,
          ...(messageId ? { id: messageId } : {}),
        },
        select: { id: true },
      }
    )
    if (!pendingMessage) return actionFailure('Start run', 'No user message found', ErrorCode.TASK_NOT_FOUND)


    const credentials = await readProjectCredentials(conversation.project_id)
    if (!credentials) return actionFailure('Start run', 'Project credentials are not ready yet')
  

    const sandbox = await provisionSandbox(conversation.project_id)
    if (!sandbox.ok) {
      return actionFailure(
        'Start run',
        'sandbox failed: ' + sandbox.error,
        sandbox.code ?? ErrorCode.TOOL_EXECUTION_FAILED
      )
    }


    const run = await prisma.$transaction(async (tx) => {
      const message = await tx.message.findFirst(
        {
          where: {
            conversation_id: conversationId,
            role: 'user',
            run_id: null,
            ...(messageId ? { id: messageId } : {}),
          },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        }
      )
      if (!message) throw new Error('Add a user message before starting a run')

      const created = await tx.agentRun.create({ data: { conversation_id: conversationId } })

      await tx.message.update({where: { id: message.id }, data: { run_id: created.id },})

      await tx.project.updateMany(
        {
          where: { id: conversation.project_id, active_run_id: null },
          data: { active_run_id: created.id, branch_name: `agent/${created.id}` },
        }
      )

      return created
    })

    return { ok: true, data: { id: run.id, status: 'QUEUED' } }
  } 
  catch (error) {
    return actionFailure(
      'Start run',
      error instanceof Error ? error.message : 'Unable to start run'
    )
  }
}





export async function submitMessage(conversationId: string,content: string): Promise<ActionResult<{ id: string; status: string }>> {
  const parsed = messageBodySchema.safeParse(content)
  if (!parsed.success) return actionFailure('Submit message', 'Message cannot be empty')

  const message = await addMessage(conversationId, parsed.data)
  if (!message.ok) return message

  return startRun(conversationId, message.data.id)
}





export async function getRun(runId: string): Promise<ActionResult<any>> {
  try {
    const run = await prisma.agentRun.findUnique(
      {
        where: { id: runId },
        include: { logs: { orderBy: { id: 'desc' }, take: 1 } },
      }
    )

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
  } 
  catch (error) {return actionFailure('Get run', error instanceof Error ? error.message : 'Unable to load run')}

}





export async function replyToRun(runId: string,reply: string): Promise<ActionResult<{ status: string }>> {
  
  const parsed = messageBodySchema.safeParse(reply)
  if (!parsed.success) return actionFailure('Reply to run', 'Reply cannot be empty')

  try {
    const run = await prisma.agentRun.findUnique(
      {
        where: { id: runId },
        include: { conversation: { select: { id: true } } },
      }
    )

    if (!run) return actionFailure('Reply to run', 'Run not found', ErrorCode.TASK_NOT_FOUND)

    const message = await prisma.message.create({
      data: {
        conversation_id: run.conversation.id,
        run_id: runId,
        role: 'user',
        content: parsed.data,
      },
    })

    const accepted = replies.submit(runId, parsed.data)
    if (!accepted.ok) {
      await prisma.message.delete({ where: { id: message.id } }).catch(() => null)
      return actionFailure('Reply to run', 'This run is no longer waiting for a reply')
    }

    return { ok: true, data: { status: 'accepted' } }
  } 
  catch (error) {
    return actionFailure('Reply to run', error instanceof Error ? error.message : 'Unable to save reply')
  }
}





export async function cancelRun(runId: string): Promise<ActionResult<{ status: string }>> {
  try {
    const run = await prisma.agentRun.findUnique(
      {
        where: { id: runId },
        include: { conversation: { select: { project_id: true } } },
      }
    )

    if (!run) return actionFailure('Cancel run', 'Run not found', ErrorCode.TASK_NOT_FOUND)
    if (isTerminalAgentRunStatus(run.status))return actionFailure('Cancel run', 'Run has already finished')

    const canceled = await runs.cancel(runId)
    const sandbox = containers.get(run.conversation.project_id)
    if (sandbox.ok) await sandbox.data.cancelRunCommands(runId).catch(() => null)
    

    if (!canceled.ok) {
      await prisma.$transaction(
        [
          prisma.agentRun.update(
            {
              where: { id: runId },
              data: { status: 'INTERRUPTED', fail_reason: 'Run cancelled', completed_at: new Date() },
            }
          ),
          prisma.project.updateMany(
            {
              where: { id: run.conversation.project_id, active_run_id: runId },
              data: { active_run_id: null },
            }
          ),
        ]
      )
    }

    return { ok: true, data: { status: 'INTERRUPTED' } }
  } 
  catch (error) {
    return actionFailure('Cancel run', error instanceof Error ? error.message : 'Unable to cancel run')
  }
}

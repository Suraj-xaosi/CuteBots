'use server'

import { prisma } from '@workspace/db'
import { redactTextSecrets } from '@workspace/core'
import { ErrorCode, type ActionResult, type ConversationDetails, type ConversationItem } from '@workspace/types'
import { z } from 'zod'
import { actionFailure } from '../action-utils'

const titleSchema = z.string().trim().max(150).optional()

const safeConversation = (conversation: {
  id: string
  project_id: string
  title: string | null
  created_at: Date
  updated_at: Date
}): ConversationItem => ({
  id: conversation.id,
  projectId: conversation.project_id,
  title: conversation.title,
  createdAt: conversation.created_at,
  updatedAt: conversation.updated_at,
})

export async function listConversations(
  projectId: string
): Promise<ActionResult<ConversationItem[]>> {
  try {
    const conversations = await prisma.conversation.findMany({
      where: { project_id: projectId },
      orderBy: { updated_at: 'desc' },
      include: {
        _count: { select: { messages: true } },
        runs: { orderBy: { created_at: 'desc' }, take: 1 },
      },
    })

    return {
      ok: true,
      data: conversations.map((conversation) => ({
        ...safeConversation(conversation),
        messageCount: conversation._count.messages,
        latestRun: conversation.runs[0]
          ? {
              id: conversation.runs[0].id,
              status: conversation.runs[0].status,
              summary: conversation.runs[0].completion_summary
                ? redactTextSecrets(conversation.runs[0].completion_summary)
                : null,
              createdAt: conversation.runs[0].created_at,
            }
          : null,
      })),
    }
  } catch (error) {
    return actionFailure('List conversations', error instanceof Error ? error.message : 'Failed to load conversations')
  }
}

export async function createConversation(
  projectId: string,
  title?: string
): Promise<ActionResult<ConversationItem>> {
  const parsed = titleSchema.safeParse(title)
  if (!parsed.success) {
    return actionFailure('Create conversation', 'Title is too long', ErrorCode.TOOL_EXECUTION_FAILED)
  }

  try {
    const conversation = await prisma.conversation.create({
      data: {
        project_id: projectId,
        title: parsed.data ?? null,
      },
    })

    return { ok: true, data: safeConversation(conversation) }
  } catch (error) {
    return actionFailure('Create conversation', error instanceof Error ? error.message : 'Failed to create conversation')
  }
}

export async function getConversation(id: string): Promise<ActionResult<ConversationDetails>> {
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { created_at: 'asc' } },
        runs: { orderBy: { created_at: 'desc' } },
      },
    })

    if (!conversation) {
      return actionFailure('Get conversation', 'Conversation not found', ErrorCode.TASK_NOT_FOUND)
    }

    const data = {
      ...safeConversation(conversation),
      messages: conversation.messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: redactTextSecrets(message.content),
        runId: message.run_id,
        createdAt: message.created_at,
      })),
      runs: conversation.runs.map((run) => ({
        id: run.id,
        status: run.status,
        summary: run.completion_summary ? redactTextSecrets(run.completion_summary) : null,
        failReason: run.fail_reason ? redactTextSecrets(run.fail_reason) : null,
        createdAt: run.created_at,
        startedAt: run.started_at,
        completedAt: run.completed_at,
      })),
    } satisfies ConversationDetails

    return { ok: true, data }
  } catch (error) {
    return actionFailure('Get conversation', error instanceof Error ? error.message : 'Failed to load conversation')
  }
}

export async function updateConversation(id: string, title: string): Promise<ActionResult<ConversationItem>> {
  const parsed = titleSchema.safeParse(title)
  if (!parsed.success) {
    return actionFailure('Update conversation', 'Title is too long', ErrorCode.TOOL_EXECUTION_FAILED)
  }

  try {
    const conversation = await prisma.conversation.update({
      where: { id },
      data: { title: parsed.data ?? null },
    })

    return { ok: true, data: safeConversation(conversation) }
  } catch (error) {
    return actionFailure('Update conversation', error instanceof Error ? error.message : 'Failed to update conversation')
  }
}

export async function deleteConversation(id: string): Promise<ActionResult<undefined>> {
  try {
    await prisma.conversation.delete({ where: { id } })
    return { ok: true, data: undefined }
  } catch (error) {
    return actionFailure('Delete conversation', error instanceof Error ? error.message : 'Failed to delete conversation')
  }
}

export async function listMessages(
  conversationId: string,
  cursor?: string,
  limit = 50
): Promise<ActionResult<{ messages: any[]; nextCursor: string | null }>> {
  try {
    const messages = await prisma.message.findMany({
      where: { conversation_id: conversationId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: limit + 1,
    })

    const hasMore = messages.length > limit
    const page = messages.slice(0, limit)

    return {
      ok: true,
      data: {
        messages: page.map((message) => ({
          id: message.id,
          role: message.role,
          content: redactTextSecrets(message.content),
          runId: message.run_id,
          createdAt: message.created_at,
        })),
        nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
      },
    }
  } catch (error) {
    return actionFailure('List messages', error instanceof Error ? error.message : 'Failed to load messages')
  }
}

export async function addMessage(
  conversationId: string,
  content: string
): Promise<ActionResult<{ id: string }>> {
  const parsed = z.string().trim().min(1).safeParse(content)
  if (!parsed.success) {
    return actionFailure('Add message', 'Message cannot be empty')
  }

  try {
    const message = await prisma.message.create({
      data: {
        conversation_id: conversationId,
        role: 'user',
        content: parsed.data,
      },
    })

    return { ok: true, data: { id: message.id } }
  } catch (error) {
    return actionFailure('Add message', error instanceof Error ? error.message : 'Failed to add message')
  }
}


'use server'

import { prisma } from '@workspace/db'
import type { ConversationDetails, ConversationItem } from '@workspace/types'
import { redactTextSecrets } from '@workspace/core'

const safeConversation = (conversation: any): ConversationItem => ({
  id: conversation.id,
  projectId: conversation.project_id,
  title: conversation.title,
  createdAt: conversation.created_at,
  updatedAt: conversation.updated_at,
})

export async function listConversations(projectId: string): Promise<any> {
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
}

export async function createConversation(projectId: string, title?: string): Promise<any> {
  const conversation = await prisma.conversation.create(
    {
      data: {
        project_id: projectId,
        title: title?.trim().slice(0, 150) || null,
      },
    }
  )

  return { ok: true, data: safeConversation(conversation) }
}

export async function getConversation(id: string): Promise<any> {
  const conversation = await prisma.conversation.findUnique(
    {
      where: { id },
      include: {
        messages: { orderBy: { created_at: 'asc' } },
        runs: { orderBy: { created_at: 'desc' } },
      },
    }
  )

  if (!conversation) return { ok: false, error: 'Conversation not found' }

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
      summary: run.completion_summary
        ? redactTextSecrets(run.completion_summary)
        : null,
      failReason: run.fail_reason ? redactTextSecrets(run.fail_reason) : null,
      createdAt: run.created_at,
      startedAt: run.started_at,
      completedAt: run.completed_at,
    })),
  } satisfies ConversationDetails

  return { ok: true, data }
}

export async function updateConversation(id: string, title: string): Promise<any> {
  const conversation = await prisma.conversation.update({
    where: { id },
    data: { title: title.trim() || null },
  })

  return { ok: true, data: safeConversation(conversation) }
}

export async function deleteConversation(id: string): Promise<any> {
  await prisma.conversation.delete({ where: { id } })
  return { ok: true }
}

export async function listMessages(
  conversationId: string,
  cursor?: string,
  limit = 50
): Promise<any> {
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
}

export async function addMessage(conversationId: string, content: string): Promise<any> {
  const message = await prisma.message.create({
    data: {
      conversation_id: conversationId,
      role: 'user',
      content,
    },
  })

  return { ok: true, data: { id: message.id } }
}

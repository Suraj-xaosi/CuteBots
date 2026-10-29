'use server'

import { prisma } from '@workspace/db'
import { ErrorCode, type ActionResult, type ProjectCredentialsView } from '@workspace/types'
import { z } from 'zod'
import { encrypt, readProjectCredentials, writeProjectCredentials } from '../credentials'
import { actionFailure } from '../action-utils'
import { providerSchema } from '../safe'

const saveCredentialsSchema = z.object({
  provider: providerSchema.optional(),
  apiKey: z.string().trim().max(500).optional().or(z.literal('')).transform((value) => value?.trim() || undefined),
  model: z.string().trim().max(80).optional().or(z.literal('')).transform((value) => value?.trim() || undefined),
  baseUrl: z.string().trim().max(200).optional().or(z.literal('')).transform((value) => value?.trim() || undefined),
  tavilyApiKey: z.string().trim().max(500).optional().or(z.literal('')).transform((value) => value?.trim() || undefined),
  repositoryToken: z.string().trim().max(500).optional().or(z.literal('')).transform((value) => value?.trim() || undefined),
})

export async function getProjectCredentials(id: string): Promise<ActionResult<ProjectCredentialsView>> {
  try {
    const project = await prisma.project.findUnique({
      where: { id },
      select: { github_token: true },
    })

    if (!project) return actionFailure('Load project credentials', 'Project not found', ErrorCode.TASK_NOT_FOUND)

    const credentials = (await readProjectCredentials(id)) ?? {}

    return {
      ok: true,
      data: {
        provider: (credentials.provider ?? '') as ProjectCredentialsView['provider'],
        model: credentials.model ?? '',
        baseUrl: credentials.baseUrl ?? '',
        hasApiKey: Boolean(credentials.apiKey),
        hasTavilyApiKey: Boolean(credentials.tavilyApiKey),
        hasRepositoryToken: Boolean(project.github_token),
      },
    }
  } catch (error) {
    return actionFailure(
      'Load project credentials',
      error instanceof Error ? error.message : 'Unable to load project credentials'
    )
  }
}

export async function saveProjectCredentials(
  id: string,
  input: Record<string, unknown>
): Promise<ActionResult<{ saved: true }>> {
  const parsed = saveCredentialsSchema.safeParse(input)
  if (!parsed.success) {
    return actionFailure('Save project credentials', 'Project credentials are invalid')
  }

  try {
    const cleanInput = parsed.data
    const values: Record<string, string> = {}

    if (cleanInput.provider !== undefined) values.provider = cleanInput.provider
    if (cleanInput.apiKey !== undefined) values.apiKey = cleanInput.apiKey
    if (cleanInput.model !== undefined) values.model = cleanInput.model
    if (cleanInput.baseUrl !== undefined) values.baseUrl = cleanInput.baseUrl
    if (cleanInput.tavilyApiKey !== undefined) values.tavilyApiKey = cleanInput.tavilyApiKey

    await writeProjectCredentials(id, values)

    if (cleanInput.repositoryToken) {
      await prisma.project.update({
        where: { id },
        data: { github_token: encrypt(cleanInput.repositoryToken) },
      })
    }

    return { ok: true, data: { saved: true } }
  } catch (error) {
    return actionFailure(
      'Save project credentials',
      error instanceof Error ? error.message : 'Unable to save project credentials'
    )
  }
}


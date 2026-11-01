'use server'

import { prisma } from '@workspace/db'
import { ErrorCode, type ActionResult, type ProjectCredentialsView } from '@workspace/types'
import { z } from 'zod'
import {
  credentialsProblem,
  encrypt,
  normalizeCredentials,
  readProjectCredentials,
  writeProjectCredentials,
} from '../credentials'
import { actionFailure } from '../action-utils'
import { providerSchema } from '../safe'

// Tri-state fields:
//   undefined -> leave as is
//   ''        -> clear it
//   'text'    -> set it
// (The old schema turned '' into undefined, so nothing could ever be cleared.)
const field = (max: number) => z.string().trim().max(max).optional()

const saveCredentialsSchema = z.object({
  provider: providerSchema.or(z.literal('')).optional(),
  apiKey: field(500),
  model: field(80),
  baseUrl: field(200),
  tavilyApiKey: field(500),
  repositoryToken: field(500),
})

const CREDENTIAL_FIELDS = ['provider', 'apiKey', 'model', 'baseUrl', 'tavilyApiKey'] as const

class InputProblem extends Error {}

export async function getProjectCredentials(id: string): Promise<ActionResult<ProjectCredentialsView>> {
  try {
    const cleanId = id.trim()
    const project = await prisma.project.findUnique({
      where: { id: cleanId },
      select: { github_token: true },
    })

    if (!project) return actionFailure('Load project credentials', 'Project not found', ErrorCode.TASK_NOT_FOUND)

    const credentials = (await readProjectCredentials(cleanId)) ?? {}

    // Write-only secrets: the browser only ever learns "is it set?", never the value.
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

  const cleanId = id.trim()
  const patch = parsed.data

  try {
    // Do not create secrets for a project that does not exist.
    const project = await prisma.project.findUnique({ where: { id: cleanId }, select: { id: true } })
    if (!project) return actionFailure('Save project credentials', 'Project not found', ErrorCode.TASK_NOT_FOUND)

    // One transaction: LLM credentials and the repo token are saved together or not at all.
    await prisma.$transaction(async (tx) => {
      const existing = (await readProjectCredentials(cleanId, tx)) ?? {}
      let next: Record<string, string> = { ...existing }

      // Switching provider? The old key / model / baseUrl belong to the OLD provider.
      // Keeping them would send the new provider's key to the old provider's URL.
      if (patch.provider && patch.provider !== existing.provider) {
        delete next.apiKey
        delete next.model
        delete next.baseUrl
      }

      for (const name of CREDENTIAL_FIELDS) {
        const value = patch[name]
        if (value === undefined) continue
        if (value === '') delete next[name]
        else next[name] = value
      }

      next = normalizeCredentials(next)

      const problem = credentialsProblem({
        ...next,
        ...(patch.repositoryToken ? { repositoryToken: patch.repositoryToken } : {}),
      })
      if (problem) throw new InputProblem(problem)

      await writeProjectCredentials(cleanId, next, tx)

      if (patch.repositoryToken !== undefined) {
        await tx.project.update({
          where: { id: cleanId },
          data: { github_token: patch.repositoryToken ? encrypt(patch.repositoryToken) : null },
        })
      }
    })

    return { ok: true, data: { saved: true } }
  } catch (error) {
    if (error instanceof InputProblem) return actionFailure('Save project credentials', error.message)
    return actionFailure(
      'Save project credentials',
      error instanceof Error ? error.message : 'Unable to save project credentials'
    )
  }
}
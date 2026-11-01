import { z } from 'zod'
import { ErrorCode, PROVIDER_NAMES, type ActionResult } from '@workspace/types'

// One source of truth: PROVIDER_NAMES lives in @workspace/types.
export const providerSchema = z.enum(PROVIDER_NAMES)

export const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value && value.trim() ? value.trim() : undefined))

export const optionalTextOrEmpty = z
  .string()
  .trim()
  .optional()
  .transform((value) => value?.trim() ?? '')

export const normalizeText = (value: string | null | undefined) =>
  value?.trim() || null

export const sanitizeRepoUrl = (value: string) => {
  const cleaned = value.trim().replace(/\.git$/, '')
  if (!cleaned) return ''

  try {
    const url = new URL(cleaned)
    return `${url.origin}${url.pathname}`
  } catch {
    return cleaned
  }
}

// NEW (Lesson 1): same rules cloneGitHubRepository enforces later, but checked
// up front so a bad URL never creates a project row that can only fail.
export const isCleanGitHubRepoUrl = (value: string) => {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.username &&
      !url.password &&
      url.pathname.split('/').filter(Boolean).length === 2
    )
  } catch {
    return false
  }
}

export const errorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return 'Something went wrong'
}

export const safeAction = async <T>(
  action: string,
  work: () => Promise<T>
): Promise<ActionResult<T>> => {
  try {
    return { ok: true, data: await work() }
  } catch (error) {
    return {
      ok: false,
      error: `${action} failed: ${errorMessage(error)}`,
      code: ErrorCode.TOOL_EXECUTION_FAILED,
    }
  }
}

export const parseJsonRecord = (raw: string | null | undefined) => {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
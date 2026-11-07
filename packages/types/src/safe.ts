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

const isAsciiLetterOrDigit = (char: string) => {
  const code = char.charCodeAt(0)
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  )
}

const isValidBranchName = (name: string) => {
  if (!name || name.length > 80) return false

  const firstChar = name[0]
  if (!firstChar || !isAsciiLetterOrDigit(firstChar)) return false

  for (const char of name) {
    if (isAsciiLetterOrDigit(char)) continue
    if (char === '.' || char === '_' || char === '-' || char === '/') continue
    return false
  }

  const segments = name.split('/')
  if (segments.some((part) => part === '' || part === '.' || part === '..')) {
    return false
  }

  if (name.endsWith('.lock')) return false
  return true
}

export const sanitizeRepoUrl = (value: string) => {
  let cleaned = value.trim()
  if (cleaned.endsWith('.git')) {
    cleaned = cleaned.slice(0, -4)
  }
  if (!cleaned) return ''

  try {
    const url = new URL(cleaned)
    return `${url.origin}${url.pathname}`
  } catch {
    return cleaned
  }
}

// same rules cloneGitHubRepository enforces later, but checked
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

// Same rules the push tool enforces later, checked when the user types the branch,
// so a bad value fails now with a clear message instead of mysteriously at push time.
export const workingBranchProblem = (value: string) => {
  const name = value.trim()
  if (!name) return null

  if (!isValidBranchName(name)) {
    return 'Branch name can only use letters, numbers, . _ - and / (no spaces).'
  }

  const normalized = name.toLowerCase()
  if (normalized === 'main' || normalized === 'master') {
    return 'The agent cannot work on main or master. Leave this empty, or use a separate branch such as agent/my-feature.'
  }

  return null
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
import 'server-only'

import { ErrorCode, type ActionResult } from '@workspace/types'

export const actionFailure = <T>(
  action: string,
  message?: string,
  code = ErrorCode.TOOL_EXECUTION_FAILED
): ActionResult<T> => ({
  ok: false,
  error: message || `${action} failed`,
  code,
})

export const isRecord = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isText = (value: unknown) => typeof value === 'string'

export const cleanString = (value: string | null | undefined) => value?.trim() || null

export const withAction = async <T>(
  action: string,
  work: () => Promise<T>
): Promise<ActionResult<T>> => {
  try {
    return { ok: true, data: await work() }
  } catch (error) {
    return actionFailure(
      action,
      error instanceof Error ? error.message : 'Unexpected error',
      ErrorCode.TOOL_EXECUTION_FAILED
    )
  }
}

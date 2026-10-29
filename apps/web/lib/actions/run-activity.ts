'use server'

import { prisma } from '@workspace/db'
import { redactTextSecrets } from '@workspace/core'
import { ErrorCode, type ActionResult, type ActivityItem } from '@workspace/types'
import { actionFailure } from '../action-utils'

export async function getRunActivity(runId: string): Promise<ActionResult<ActivityItem[]>> {
  try {
    const logs = await prisma.agentLog.findMany({
      where: { run_id: runId },
      orderBy: { id: 'desc' },
      take: 100,
    })

    const data: ActivityItem[] = logs.reverse().map((log) => ({
      id: log.id,
      runId: log.run_id,
      type: log.type as ActivityItem['type'],
      content: redactTextSecrets(log.content),
      createdAt: log.created_at,
    }))

    return { ok: true, data }
  } catch (error) {
    return actionFailure(
      'Load run activity',
      error instanceof Error ? error.message : 'Unable to load run activity',
      ErrorCode.TOOL_EXECUTION_FAILED
    )
  }
}

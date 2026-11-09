import 'server-only'

import { prisma } from '@workspace/db'
import { isTerminalAgentRunStatus } from '@workspace/types'

export async function waitForRunToFinish(runId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: { status: true },
    })

    if (!run || isTerminalAgentRunStatus(run.status)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

export async function forceFinishRun(
  runId: string,
  projectId: string,
  reason = 'Run stopped by user',
) {
  await prisma.$transaction([
    prisma.agentRun.updateMany({
      where: { id: runId, status: { notIn: ['DONE', 'FAILED', 'INTERRUPTED'] } },
      data: { status: 'INTERRUPTED', fail_reason: reason, completed_at: new Date() },
    }),
    prisma.project.updateMany({
      where: { id: projectId, active_run_id: runId },
      data: { active_run_id: null },
    }),
  ])
}

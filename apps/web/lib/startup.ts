import 'server-only'

import { prisma } from '@workspace/db'
import { containers, runs } from './agent-runtime'

export async function recoverProjectSandboxes() {
  const projects = await prisma.project.findMany({ select: { id: true } })

  for (const { id } of projects) {
    try {
      const recovered = await containers.recover(id)
      const current = recovered.ok ? containers.get(id) : null

      await prisma.project.update({
        where: { id },
        data: {
          sandbox_status: recovered.ok ? 'RUNNING' : 'STOPPED',
          container_id: current?.ok ? current.data.getId() : null,
        },
      })
    } catch (error) {
      console.error('Recover sandbox failed', { projectId: id, error })

      await prisma.project
        .update({
          where: { id },
          data: { sandbox_status: 'STOPPED', container_id: null },
        })
        .catch(() => null)
    }
  }
}

export async function gracefullyStopRuns() {
  const projects = await prisma.project.findMany({
    where: { active_run_id: { not: null } },
    select: { id: true, active_run_id: true },
  })

  for (const { id, active_run_id: runId } of projects) {
    if (!runId) continue

    try {
      await runs.cancel(runId)

      const sandbox = containers.get(id)
      if (sandbox.ok) {
        await sandbox.data.cancelRunCommands(runId).catch(() => null)
      }

      await prisma.agentRun.updateMany({
        where: { id: runId },
        data: {
          status: 'INTERRUPTED',
          fail_reason: 'Run interrupted during graceful server shutdown',
          completed_at: new Date(),
        },
      })

      await prisma.project.updateMany({
        where: { id, active_run_id: runId },
        data: { active_run_id: null },
      })
    } catch (error) {
      console.error('Graceful stop failed', { projectId: id, runId, error })
    }
  }
}

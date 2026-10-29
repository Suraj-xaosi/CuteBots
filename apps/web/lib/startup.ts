import "server-only"

import { prisma } from "@workspace/db"
import { containers, runs } from "./agent-runtime"

export async function recoverProjectSandboxes() {
  const projects = await prisma.project.findMany({ select: { id: true } })

  for (const { id } of projects) {
    const recovered = await containers.recover(id)
    if (recovered.ok) {
      await prisma.project.update(  { where: { id },data: { sandbox_status: "RUNNING" },} )
    }
    else {
      await prisma.project.update(
        {
          where: { id },
          data: { sandbox_status: "STOPPED", container_id: null },
        }
      )
    }
  }
}




export async function gracefullyStopRuns() {

  const projects = await prisma.project.findMany(
    {
      where: { active_run_id: { not: null } },
      select: { id: true, active_run_id: true },
    }
  )

  for (const { id, active_run_id: runId } of projects) {
    if (!runId) continue
    await runs.cancel(runId)

    const sandbox = containers.get(id)
    if (sandbox.ok) {await sandbox.data.cancelRunCommands(runId)}

    await prisma.agentRun.updateMany(
      {
        where: { id: runId },
        data: {
          status: "INTERRUPTED",
          fail_reason: "Run interrupted during graceful server shutdown",
          completed_at: new Date(),
        },
    })

    await prisma.project.updateMany(
      {
        where: { id, active_run_id: runId },
        data: { active_run_id: null },
      }
    )
  }
}

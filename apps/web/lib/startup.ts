import 'server-only'

import { prisma } from '@workspace/db'
import { containers, runs } from './agent-runtime'
import { assertCredentialsConfigured } from './credentials'
import { forceFinishRun, waitForRunToFinish } from './run-control'

// Next.js dev can call startup hooks more than once; make boot work run once per process.
const globalForBoot = globalThis as unknown as { __cutebotsBooted?: boolean }

async function step(name: string, work: () => Promise<void>) {
  try {
    await work()
  } catch (error) {
    // One failing step must not stop the others from running.
    console.error(`[boot] ${name} failed`, error)
  }
}

// Call once when the server starts.
//
// Rule of boot: right after a start NOTHING is running in memory. So anything the
// database still calls "active" is a leftover from a crash or a restart, and we fix it.
export async function recoverOnBoot() {
  if (globalForBoot.__cutebotsBooted) return
  globalForBoot.__cutebotsBooted = true

  await step('check configuration', async () => {
    try {
      assertCredentialsConfigured()
    } catch (error) {
      console.error(
        `[boot] ${error instanceof Error ? error.message : 'Credentials key is not configured'}. ` +
          'Saving or reading API keys will not work until this is fixed.'
      )
    }
  })

  // 1. Zombie runs: QUEUED / RUNNING / WAITING_FOR_INPUT with nobody running them.
  await step('interrupt leftover runs', async () => {
    const leftovers = await prisma.agentRun.findMany({
      where: { status: { in: ['QUEUED', 'RUNNING', 'WAITING_FOR_INPUT', 'AWAITING_APPROVAL'] } },
      select: { id: true },
    })

    if (leftovers.length > 0) {
      const ids = leftovers.map((run) => run.id)
      await prisma.$transaction([
        // log first, status last (same rule as the agent loop)
        prisma.agentLog.createMany({
          data: ids.map((run_id) => ({
            run_id,
            type: 'status',
            content: 'Run interrupted because the server restarted. Your conversation is kept; send a message to continue.',
          })),
        }),
        prisma.agentLog.deleteMany({ where: { run_id: { in: ids }, type: 'assistant_delta' } }),
        prisma.agentRun.updateMany({
          where: { id: { in: ids } },
          data: { status: 'INTERRUPTED', fail_reason: 'Server restarted while the run was active', completed_at: new Date() },
        }),
      ])
      console.warn(`[boot] interrupted ${ids.length} leftover run(s)`)
    }

    // No project may keep a lock after boot, whatever state its run was in.
    await prisma.project.updateMany({ where: { active_run_id: { not: null } }, data: { active_run_id: null } })
  })

  // 2. Setup / delete that was cut off in the middle.
  await step('reset interrupted setup', async () => {
    await prisma.project.updateMany({
      where: { provision_status: 'PROVISIONING' },
      data: {
        provision_status: 'FAILED',
        provision_error: 'Setup was interrupted by a restart. Press Start to try again.',
      },
    })
    await prisma.project.updateMany({
      where: { sandbox_status: { in: ['STARTING', 'DESTROYING'] } },
      data: { sandbox_status: 'STOPPED' },
    })
  })

  // 3. Containers whose project no longer exists (a delete that died half way).
  //    We deliberately do NOT start every project's container here (the old code did,
  //    which could launch many 512 MB containers at once). A sandbox is re-attached
  //    lazily when its project is opened or a run starts.
  await step('remove stale containers', async () => {
    const projects = await prisma.project.findMany({ select: { id: true } })
    const cleaned = await containers.cleanupStale(new Set(projects.map((project) => project.id)))
    if (!cleaned.ok) console.warn('[boot] stale container cleanup skipped:', cleaned.error)
  })
}

// Old name kept so existing wiring (instrumentation.ts) keeps working.
export const recoverProjectSandboxes = recoverOnBoot

// Call on SIGTERM / SIGINT. Stops active runs quickly and records why.
export async function gracefullyStopRuns() {
  const projects = await prisma.project.findMany({
    where: { active_run_id: { not: null } },
    select: { id: true, active_run_id: true },
  })

  await Promise.all(
    projects.map(async ({ id, active_run_id: runId }) => {
      if (!runId) return

      try {
        await runs.cancel(runId)

        const sandbox = containers.get(id)
        if (sandbox.ok) {
          await sandbox.data.cancelRunCommands(runId).catch(() => null)
        }

        await waitForRunToFinish(runId, 2_000)
        await forceFinishRun(runId, id, 'Run interrupted during graceful server shutdown')
      } catch (error) {
        console.error('Graceful stop failed', { projectId: id, runId, error })
      }
    })
  )
}
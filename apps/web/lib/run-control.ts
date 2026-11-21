import 'server-only'

import { prisma } from '@workspace/db'
import { publishRunStatus } from '@workspace/core'
import { AgentRunStatus, isTerminalAgentRunStatus } from '@workspace/types'
import { persistence } from './agent-persistence'
import { events } from './agent-runtime'

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

// Last resort: make sure a run is over, even if the agent loop is stuck.
// The callers (cancelRun, hard stop, shutdown) already gave the loop time to
// finish by itself. If it did, there is nothing to do here except make sure
// the project lock is free.
//
// CHANGED: before, this only changed the database. The browser never heard
// about it. Now a forced stop goes through publishRunStatus, so the browser
// gets an "info" line and the status event "INTERRUPTED" like any other stop.
export async function forceFinishRun(
  runId: string,
  projectId: string,
  reason = 'Run stopped by user',
) {
  try {
    // Look first. If the loop already finished the run by itself, we must not
    // add a second "stopped by user" line to the Activity list.
    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      select: { status: true },
    })

    if (run && !isTerminalAgentRunStatus(run.status)) {
      await publishRunStatus(
        persistence,
        // Tiny channel: it only forwards events to the live stream.
        { sendLog: async (event) => events.publish(event) },
        runId,
        AgentRunStatus.INTERRUPTED,
        { reason, info: reason },
      )
    }
  } finally {
    // ALWAYS free the project, even if the status write failed or the run is
    // gone. A locked project would block every new message. (Before, the status
    // and the lock were changed in one transaction. Both steps are safe to
    // repeat, so two steps are fine, and startup.ts also clears stale locks.)
    await prisma.project.updateMany({
      where: { id: projectId, active_run_id: runId },
      data: { active_run_id: null },
    })
  }
}

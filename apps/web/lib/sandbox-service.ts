import 'server-only'

import { cloneGitHubRepository, redactTextSecrets } from '@workspace/core'
import { prisma } from '@workspace/db'
import { ErrorCode, type ActionResult } from '@workspace/types'
import { z } from 'zod'
import { containers } from './agent-runtime'
import { decrypt } from './credentials'

type ProvisionResult = ActionResult<{ containerId: string }>

const projectIdSchema = z.string().trim().min(1)

// Singleflight: at most ONE provisioning per project at a time.
// A second caller (e.g. startRun right after createProject) simply waits for
// the same promise instead of racing a second `git clone` / `docker run`.
// Kept on globalThis so Next.js hot-reload / separate bundles share one Map.
const globalForProvision = globalThis as unknown as {
  __cutebotsProvisionInflight?: Map<string, Promise<ProvisionResult>>
}
const inflight = (globalForProvision.__cutebotsProvisionInflight ??= new Map())




export function provisionSandbox(projectId: string): Promise<ProvisionResult> {
  const parsed = projectIdSchema.safeParse(projectId)
  if (!parsed.success) {
    return Promise.resolve({
      ok: false,
      error: 'Project id is invalid',
      code: ErrorCode.TASK_NOT_FOUND,
    })
  }

  const cleanId = parsed.data
  const running = inflight.get(cleanId)
  if (running) return running

  const work = doProvision(cleanId).finally(() => inflight.delete(cleanId))
  inflight.set(cleanId, work)
  return work
}




async function doProvision(projectId: string): Promise<ProvisionResult> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) {
      return { ok: false, error: 'Project not found', code: ErrorCode.TASK_NOT_FOUND }
    }

    // A delete/destroy is in progress: do not race it and create a container nobody will own.
    if (project.sandbox_status === 'DESTROYING') {
      return { ok: false, error: 'The sandbox is being deleted. Try again in a moment.', code: ErrorCode.CONTAINER_NOT_FOUND }
    }

    // From here on, EVERY exit path must leave a terminal status (READY or FAILED).
    await prisma.project.update({
      where: { id: projectId },
      data: { provision_status: 'PROVISIONING', sandbox_status: 'STARTING', provision_error: null },
    })

    let sandboxResult = containers.get(projectId)
    if (!sandboxResult.ok) {
      const recovered = await containers.recover(projectId)
      sandboxResult = recovered.ok ? containers.get(projectId) : await containers.create(projectId)
    }

    if (!sandboxResult.ok) {
      return failProvision(
        projectId,
        sandboxResult.error || 'Failed during container setup',
        sandboxResult.code ?? ErrorCode.CONTAINER_NOT_FOUND
      )
    }

    if (project.repo_url) {
      let githubToken: string | undefined
      try {
        githubToken = project.github_token ? decrypt(project.github_token) : undefined
      } catch {
        return failProvision(
          projectId,
          'Saved repository token is unreadable. Save the token again in project settings.',
          ErrorCode.GIT_CLONE_FAILED
        )
      }

      const clone = await cloneGitHubRepository(
        sandboxResult.data,
        project.repo_url,
        project.id,
        githubToken
      )

      if (!clone.success) {
        return failProvision(
          projectId,
          clone.output || 'Repository clone failed',
          ErrorCode.GIT_CLONE_FAILED
        )
      }
    }

    const containerId = sandboxResult.data.getId()
    if (!containerId) {
      return failProvision(
        projectId,
        'Sandbox container id is missing',
        ErrorCode.CONTAINER_NOT_FOUND
      )
    }

    await prisma.project.update({
      where: { id: projectId },
      data: {
        container_id: containerId,
        sandbox_status: 'RUNNING',
        provision_status: 'READY',
        provision_error: null,
      },
    })

    return { ok: true, data: { containerId } }
  } catch (error) {
    console.error('Provision sandbox failed', { projectId, error })
    return failProvision(
      projectId,
      error instanceof Error ? error.message : 'Provision sandbox failed',
      ErrorCode.TOOL_EXECUTION_FAILED
    )
  }
}




// Single place that writes FAILED. Never throws (the project row may be gone).
async function failProvision(
  projectId: string,
  error: string,
  code: ErrorCode
): Promise<ProvisionResult> {
  const message = redactTextSecrets(error).slice(0, 2_000)
  const sandbox = containers.get(projectId)

  await prisma.project.update({
    where: { id: projectId },
    data: {
      provision_status: 'FAILED',
      provision_error: message,
      sandbox_status: sandbox.ok ? 'RUNNING' : 'STOPPED',
      container_id: sandbox.ok ? sandbox.data.getId() : null,
    },
  })
    .catch((updateError) => {
      console.error('Unable to record provision failure', { projectId, updateError })
    })

  return { ok: false, error: message, code }
}
import 'server-only'

import { cloneGitHubRepository } from '@workspace/core'
import { prisma } from '@workspace/db'
import { ErrorCode, type ActionResult } from '@workspace/types'
import { z } from 'zod'
import { containers } from './agent-runtime'
import { decrypt } from './credentials'

const projectIdSchema = z.string().trim().min(1)

export async function provisionSandbox(
  projectId: string
): Promise<ActionResult<{ containerId: string }>> {
  const parsed = projectIdSchema.safeParse(projectId)
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Project id is invalid',
      code: ErrorCode.TASK_NOT_FOUND,
    }
  }

  const cleanId = parsed.data

  try {
    const project = await prisma.project.findUnique({ where: { id: cleanId } })
    if (!project) {
      return { ok: false, error: 'Project not found', code: ErrorCode.TASK_NOT_FOUND }
    }

    let sandboxResult = containers.get(cleanId)
    if (!sandboxResult.ok) {
      const recovered = await containers.recover(cleanId)
      sandboxResult = recovered.ok ? containers.get(cleanId) : await containers.create(cleanId)
    }

    if (!sandboxResult.ok) {
      return { ok: false, error: 'Failed during container setup', code: ErrorCode.CONTAINER_NOT_FOUND }
    }

    if (project.repo_url) {
      const githubToken = project.github_token ? decrypt(project.github_token) : undefined
      const clone = await cloneGitHubRepository(
        sandboxResult.data,
        project.repo_url,
        project.id,
        githubToken
      )

      if (!clone.success) {
        const cloneError = clone.output ?? 'Repository clone failed'

        await prisma.project.update({
          where: { id: cleanId },
          data: {
            provision_status: 'FAILED',
            provision_error: cloneError,
          },
        })

        return {
          ok: false,
          error: cloneError,
          code: ErrorCode.GIT_CLONE_FAILED,
        }
      }
    }

    const containerId = sandboxResult.data.getId()
    if (!containerId) {
      return {
        ok: false,
        error: 'Sandbox container id is missing',
        code: ErrorCode.CONTAINER_NOT_FOUND,
      }
    }

    await prisma.project.update({
      where: { id: cleanId },
      data: {
        container_id: containerId,
        sandbox_status: 'RUNNING',
        provision_status: 'READY',
        provision_error: null,
      },
    })

    return { ok: true, data: { containerId } }
  } catch (error) {
    console.error('Provision sandbox failed', { projectId: cleanId, error })
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Provision sandbox failed',
      code: ErrorCode.TOOL_EXECUTION_FAILED,
    }
  }
}

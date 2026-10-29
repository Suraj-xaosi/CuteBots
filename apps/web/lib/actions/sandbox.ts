
"use server"

import path from 'node:path'
import { prisma } from '@workspace/db'
import {
  ErrorCode,
  ProjectProvisionStatus,
  SandboxStatus,
  type ActionResult,
  type SandboxStatusView,
} from '@workspace/types'
import { z } from 'zod'
import { containers } from '../agent-runtime'
import { provisionSandbox } from '../sandbox-service'
import { actionFailure } from '../action-utils'

const projectIdSchema = z.string().trim().min(1)

export async function openSandbox(projectId: string): Promise<ActionResult<any>> {
  const parsed = projectIdSchema.safeParse(projectId)
  if (!parsed.success) {
    return actionFailure('Open sandbox', 'Project id is invalid', ErrorCode.TASK_NOT_FOUND)
  }

  try {
    const project = await prisma.project.findUnique({
      where: { id: parsed.data },
      select: { sandbox_status: true },
    })

    if (!project) {
      return actionFailure('Open sandbox', 'Project not found', ErrorCode.TASK_NOT_FOUND)
    }

    const attached = containers.get(parsed.data)
    if (attached.ok) return attached

    const recovered = await containers.recover(parsed.data)
    if (recovered.ok) return containers.get(parsed.data)

    return { ok: false, error: 'Unable to access project sandbox', code: ErrorCode.CONTAINER_NOT_FOUND }
  } catch (error) {
    return actionFailure(
      'Open sandbox',
      error instanceof Error ? error.message : 'Unable to open sandbox'
    )
  }
}

export async function getSandboxStatus(projectId: string): Promise<ActionResult<SandboxStatusView>> {
  const parsed = projectIdSchema.safeParse(projectId)
  if (!parsed.success) {
    return actionFailure('Get sandbox status', 'Project id is invalid', ErrorCode.TASK_NOT_FOUND)
  }

  try {
    const project = await prisma.project.findUnique({
      where: { id: parsed.data },
      select: {
        sandbox_status: true,
        provision_status: true,
        provision_error: true,
      },
    })

    if (!project) {
      return actionFailure('Get sandbox status', 'Project not found', ErrorCode.TASK_NOT_FOUND)
    }

    return {
      ok: true,
      data: {
        status: project.sandbox_status,
        provisionStatus: project.provision_status,
        error: project.provision_error ? 'Project setup failed' : null,
      },
    }
  } catch (error) {
    return actionFailure(
      'Get sandbox status',
      error instanceof Error ? error.message : 'Unable to load sandbox status'
    )
  }
}

export async function startSandbox(
  projectId: string
): Promise<ActionResult<{ status: string; provisionStatus: string }>> {
  const result = await provisionSandbox(projectId)
  if (result.ok) {
    return {
      ok: true,
      data: {
        status: SandboxStatus.RUNNING,
        provisionStatus: ProjectProvisionStatus.READY,
      },
    }
  }

  return result as ActionResult<{ status: string; provisionStatus: string }>
}

export async function stopSandbox(projectId: string): Promise<ActionResult<{ status: string }>> {
  const parsed = projectIdSchema.safeParse(projectId)
  if (!parsed.success) {
    return actionFailure('Stop sandbox', 'Project id is invalid', ErrorCode.TASK_NOT_FOUND)
  }

  try {
    const result = await containers.stop(parsed.data)
    if (!result.ok) {
      return actionFailure('Stop sandbox', 'Unable to stop project sandbox', ErrorCode.CONTAINER_NOT_FOUND)
    }

    await prisma.project.update({
      where: { id: parsed.data },
      data: { sandbox_status: 'STOPPED', container_id: null },
    })

    return { ok: true, data: { status: 'STOPPED' } }
  } catch (error) {
    return actionFailure('Stop sandbox', error instanceof Error ? error.message : 'Unable to stop sandbox')
  }
}

export async function listProjectFiles(
  projectId: string,
  directory = '.'
): Promise<ActionResult<any>> {
  const parsed = projectIdSchema.safeParse(projectId)
  if (!parsed.success) {
    return actionFailure('List project files', 'Project id is invalid', ErrorCode.TASK_NOT_FOUND)
  }

  try {
    const result = await openSandbox(parsed.data)
    if (!result.ok) return result

    const target = directory.trim() || '.'
    const listing = await result.data.exec(`ls -la ${target}`)
    if (!listing.ok) {
      return actionFailure('List project files', 'Unable to list project files')
    }

    return {
      ok: true,
      data: {
        entries: [{
          name: path.basename(target),
          path: target,
          type: 'directory',
          size: 0,
          modifiedAt: Date.now(),
        }],
        hasmore: false,
      },
    }
  } catch (error) {
    return actionFailure('List project files', error instanceof Error ? error.message : 'Unable to list project files')
  }
}

export async function readProjectFile(
  projectId: string,
  filePath: string
): Promise<ActionResult<any>> {
  const parsed = projectIdSchema.safeParse(projectId)
  if (!parsed.success) {
    return actionFailure('Read project file', 'Project id is invalid', ErrorCode.TASK_NOT_FOUND)
  }

  try {
    const result = await openSandbox(parsed.data)
    if (!result.ok) return result

    const safePath = filePath.trim() || '.'
    const content = await result.data.readFile(safePath)
    if (!content.ok) {
      return actionFailure('Read project file', 'Unable to read project file')
    }

    return {
      ok: true,
      data: {
        path: safePath,
        size: content.data.length,
        content: content.data,
      },
    }
  } catch (error) {
    return actionFailure('Read project file', error instanceof Error ? error.message : 'Unable to read project file')
  }
}

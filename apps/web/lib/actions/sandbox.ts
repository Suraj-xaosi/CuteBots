"use server"

import { prisma } from '@workspace/db'
import type { Sandbox } from '@workspace/core'
import {
  ErrorCode,
  ProjectProvisionStatus,
  SandboxStatus,
  isTerminalAgentRunStatus,
  type ActionResult,
  type ProjectFileEntry,
  type ProjectFilePreview,
  type Result,
  type SandboxStatusView,
} from '@workspace/types'
import { z } from 'zod'
import { containers } from '../agent-runtime'
import { provisionSandbox } from '../sandbox-service'
import { actionFailure } from '../action-utils'
import { cancelRun } from './runs'

const projectIdSchema = z.string().trim().min(1)
const pathSchema = z.string().trim().min(1).max(4_096)

const HIDDEN_ENTRIES = new Set(['.git', 'node_modules'])
const MAX_PREVIEW_CHARS = 200_000
const STOP_WAIT_FOR_RUN_MS = 5_000



// ---------------------------------------------------------------------------
// Private helpers.
// IMPORTANT: a 'use server' file turns every EXPORTED function into a public
// endpoint. These stay un-exported on purpose (the old exported openSandbox
// tried to send a live Sandbox object to the browser).
// ---------------------------------------------------------------------------

// Find the sandbox in memory, or re-attach after a server restart.
async function attachSandbox(projectId: string): Promise<Result<Sandbox>> {
  const attached = containers.get(projectId)
  if (attached.ok) return attached

  const recovered = await containers.recover(projectId)
  if (recovered.ok) return containers.get(projectId)

  return { ok: false, error: 'Sandbox is not available', code: ErrorCode.CONTAINER_NOT_FOUND }
}

// For READ actions: they must never change lifecycle state.
// A sandbox the user stopped stays stopped; we do not silently restart it.
async function requireRunningSandbox(projectId: string): Promise<Result<Sandbox>> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { sandbox_status: true },
  })
  if (!project) return { ok: false, error: 'Project not found', code: ErrorCode.TASK_NOT_FOUND }
  if (project.sandbox_status !== 'RUNNING') {
    return { ok: false, error: 'Sandbox is stopped. Start it first.', code: ErrorCode.CONTAINER_NOT_FOUND }
  }
  return attachSandbox(projectId)
}

async function waitForRunToFinish(runId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true } })
    if (!run || isTerminalAgentRunStatus(run.status)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}


type Blocker = { error: string; code: ErrorCode } | null

// Hard-stop guarantee: whatever the agent loop is doing, after this the run is
// terminal and the project is free (no zombie run, no stuck active_run_id).
async function forceFinishRun(runId: string, projectId: string) {
  await prisma.$transaction([
    prisma.agentRun.updateMany({
      where: { id: runId, status: { notIn: ['DONE', 'FAILED', 'INTERRUPTED'] } },
      data: { status: 'INTERRUPTED', fail_reason: 'Run stopped by user', completed_at: new Date() },
    }),
    prisma.project.updateMany({
      where: { id: projectId, active_run_id: runId },
      data: { active_run_id: null },
    }),
  ])
}

// Shared gate for Stop and Destroy.
//  - setup in progress      -> refuse
//  - run active, no force   -> refuse with TASK_ALREADY_RUNNING (UI shows the popup)
//  - run active, force=true -> cancel it, wait briefly, then guarantee it is finished
async function resolveActiveRun(
  project: { id: string; active_run_id: string | null; provision_status: string },
  force: boolean
): Promise<Blocker> {
  if (project.provision_status === 'PROVISIONING') {
    return { error: 'Setup is still in progress. Try again when it finishes.', code: ErrorCode.TOOL_EXECUTION_FAILED }
  }

  const runId = project.active_run_id
  if (!runId) return null

  if (!force) {
    return {
      error: 'An agent run is still active. Hard stop the run to continue, or cancel.',
      code: ErrorCode.TASK_ALREADY_RUNNING,
    }
  }

  await cancelRun(runId).catch(() => null)
  await waitForRunToFinish(runId, STOP_WAIT_FOR_RUN_MS)
  await forceFinishRun(runId, project.id)
  return null
}



export async function getSandboxStatus(projectId: string): Promise<ActionResult<SandboxStatusView>> {
  const parsed = projectIdSchema.safeParse(projectId)
  if (!parsed.success) {
    return actionFailure('Get sandbox status', 'Project id is invalid', ErrorCode.TASK_NOT_FOUND)
  }

  try {
    const id = parsed.data
    const project = await prisma.project.findUnique({
      where: { id },
      select: {
        sandbox_status: true,
        provision_status: true,
        provision_error: true,
      },
    })

    if (!project) {
      return actionFailure('Get sandbox status', 'Project not found', ErrorCode.TASK_NOT_FOUND)
    }

    // The DB only remembers what we LAST knew. If it says RUNNING, verify once
    // (cheap; re-attaches after a restart). If reality disagrees, heal the DB
    // so the UI never shows a "RUNNING" sandbox that is actually gone.
    let status = project.sandbox_status
    if (status === 'RUNNING') {
      const attached = await attachSandbox(id)
      if (!attached.ok) {
        status = 'STOPPED'
        await prisma.project.updateMany({
          where: { id, sandbox_status: 'RUNNING' },
          data: { sandbox_status: 'STOPPED', container_id: null },
        })
      }
    }

    return {
      ok: true,
      data: {
        status,
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
  const parsed = projectIdSchema.safeParse(projectId)
  if (!parsed.success) {
    return actionFailure('Start sandbox', 'Project id is invalid', ErrorCode.TASK_NOT_FOUND)
  }

  // Safe to double-click: provisionSandbox is singleflight per project.
  const result = await provisionSandbox(parsed.data)
  if (!result.ok) return actionFailure('Start sandbox', result.error, result.code)

  return {
    ok: true,
    data: {
      status: SandboxStatus.RUNNING,
      provisionStatus: ProjectProvisionStatus.READY,
    },
  }
}



// Stops the CONTAINER only. Files inside it are kept; Start brings it back.
// Does NOT touch an agent run unless the user confirmed a hard stop (force: true).
export async function stopSandbox(
  projectId: string,
  options: { force?: boolean } = {}
): Promise<ActionResult<{ status: string }>> {
  const parsed = projectIdSchema.safeParse(projectId)
  if (!parsed.success) {
    return actionFailure('Stop sandbox', 'Project id is invalid', ErrorCode.TASK_NOT_FOUND)
  }

  try {
    const id = parsed.data
    const project = await prisma.project.findUnique({
      where: { id },
      select: { active_run_id: true, provision_status: true },
    })
    if (!project) return actionFailure('Stop sandbox', 'Project not found', ErrorCode.TASK_NOT_FOUND)

    const blocker = await resolveActiveRun({ id, ...project }, options?.force === true)
    if (blocker) return actionFailure('Stop sandbox', blocker.error, blocker.code)

    const result = await containers.stop(id)
    if (!result.ok) {
      return actionFailure('Stop sandbox', 'Unable to stop project sandbox', ErrorCode.CONTAINER_NOT_FOUND)
    }

    await prisma.project.update({
      where: { id },
      data: { sandbox_status: 'STOPPED', container_id: null },
    })

    return { ok: true, data: { status: 'STOPPED' } }
  } catch (error) {
    return actionFailure('Stop sandbox', error instanceof Error ? error.message : 'Unable to stop sandbox')
  }
}



// Deletes the CONTAINER and everything inside it (cloned repo, uncommitted work).
// The project record, conversations and credentials stay. Next Start re-creates
// the container and clones the repo again.
export async function destroySandbox(
  projectId: string,
  options: { force?: boolean } = {}
): Promise<ActionResult<{ status: string }>> {
  const parsed = projectIdSchema.safeParse(projectId)
  if (!parsed.success) {
    return actionFailure('Destroy sandbox', 'Project id is invalid', ErrorCode.TASK_NOT_FOUND)
  }

  try {
    const id = parsed.data
    const project = await prisma.project.findUnique({
      where: { id },
      select: { active_run_id: true, provision_status: true },
    })
    if (!project) return actionFailure('Destroy sandbox', 'Project not found', ErrorCode.TASK_NOT_FOUND)

    const blocker = await resolveActiveRun({ id, ...project }, options?.force === true)
    if (blocker) return actionFailure('Destroy sandbox', blocker.error, blocker.code)

    await prisma.project.update({ where: { id }, data: { sandbox_status: 'DESTROYING' } })

    const result = await containers.destroy(id)
    if (!result.ok) {
      // Be truthful: if it is still attached, it is still running.
      await prisma.project
        .update({
          where: { id },
          data: { sandbox_status: containers.get(id).ok ? 'RUNNING' : 'STOPPED' },
        })
        .catch(() => null)
      return actionFailure('Destroy sandbox', 'Unable to destroy project sandbox', ErrorCode.CONTAINER_EXEC_FAILED)
    }

    await prisma.project.update({
      where: { id },
      data: {
        sandbox_status: 'STOPPED',
        container_id: null,
        provision_status: 'PENDING', // workspace is gone: next Start must clone again
        provision_error: null,
      },
    })

    return { ok: true, data: { status: 'STOPPED' } }
  } catch (error) {
    return actionFailure('Destroy sandbox', error instanceof Error ? error.message : 'Unable to destroy sandbox')
  }
}



export async function listProjectFiles(
  projectId: string,
  directory = '.'
): Promise<ActionResult<{ entries: ProjectFileEntry[]; hasmore: boolean }>> {
  const parsedId = projectIdSchema.safeParse(projectId)
  if (!parsedId.success) {
    return actionFailure('List project files', 'Project id is invalid', ErrorCode.TASK_NOT_FOUND)
  }
  const parsedDir = pathSchema.safeParse(directory || '.')
  if (!parsedDir.success) {
    return actionFailure('List project files', 'Directory path is invalid')
  }

  try {
    const sandbox = await requireRunningSandbox(parsedId.data)
    if (!sandbox.ok) return actionFailure('List project files', sandbox.error, sandbox.code)

    // The sandbox confines the path to /workspace and passes it as an argument
    // (never inside a shell string), so there is nothing to inject into.
    const listing = await sandbox.data.listDirectory(parsedDir.data)
    if (!listing.ok) return actionFailure('List project files', 'Unable to list project files')

    const base = parsedDir.data === '.' ? '' : `${parsedDir.data.replace(/\/+$/, '')}/`
    const entries: ProjectFileEntry[] = listing.data
      .filter((entry) => !HIDDEN_ENTRIES.has(entry.name))
      .map((entry): ProjectFileEntry => {
        const type: ProjectFileEntry['type'] =
          entry.kind === 'directory' ? 'directory' : entry.kind === 'symlink' ? 'symlink' : 'file'

        return {
          name: entry.name,
          path: `${base}${entry.name}`,
          type,
          size: entry.size,
          modifiedAt: entry.modifiedAtMs,
        }
      })
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1
      )

    // The sandbox returns at most 500 entries per directory.
    return { ok: true, data: { entries, hasmore: listing.data.length >= 500 } }
  } catch (error) {
    return actionFailure('List project files', error instanceof Error ? error.message : 'Unable to list project files')
  }
}



export async function readProjectFile(
  projectId: string,
  filePath: string
): Promise<ActionResult<ProjectFilePreview>> {
  const parsedId = projectIdSchema.safeParse(projectId)
  if (!parsedId.success) {
    return actionFailure('Read project file', 'Project id is invalid', ErrorCode.TASK_NOT_FOUND)
  }
  const parsedPath = pathSchema.safeParse(filePath)
  if (!parsedPath.success) {
    return actionFailure('Read project file', 'File path is invalid')
  }

  try {
    const sandbox = await requireRunningSandbox(parsedId.data)
    if (!sandbox.ok) return actionFailure('Read project file', sandbox.error, sandbox.code)

    const content = await sandbox.data.readFile(parsedPath.data)
    if (!content.ok) return actionFailure('Read project file', 'Unable to read project file')

    const text = content.data
    if (text.includes('\u0000')) {
      return actionFailure('Read project file', 'Binary files cannot be previewed')
    }

    const truncated = text.length > MAX_PREVIEW_CHARS
    return {
      ok: true,
      data: {
        path: parsedPath.data,
        size: Buffer.byteLength(text, 'utf8'),
        content: truncated ? `${text.slice(0, MAX_PREVIEW_CHARS)}\n\n… [preview truncated]` : text,
      },
    }
  } catch (error) {
    return actionFailure('Read project file', error instanceof Error ? error.message : 'Unable to read project file')
  }
}
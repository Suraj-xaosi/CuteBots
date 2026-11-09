'use server'

import { prisma, type Prisma } from '@workspace/db'
import { ErrorCode, type ActionResult, type CreateProjectInput, type ProjectListItem, type ProjectView, type UpdateProjectInput, isCleanGitHubRepoUrl, providerSchema, sanitizeRepoUrl, workingBranchProblem } from '@workspace/types'
import { z } from 'zod'
import { provisionSandbox } from '../sandbox-service'
import { actionFailure } from '../action-utils'
import { credentialsProblem, deleteProjectCredentials, encrypt, hasUsableCredentials, normalizeCredentials, readProjectCredentials, writeProjectCredentials } from '../credentials'
import { containers } from '../agent-runtime'
import { cancelRun } from './runs'



const optionalField = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal('')).transform((value) => value?.trim() || undefined)

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  repositoryUrl: z.string().trim().min(1).max(400),
  branchName: optionalField(80),
  context: z.string().trim().max(500).optional().or(z.literal('')).transform((value) => value?.trim() ?? ''),
  repositoryToken: optionalField(500),
  // NEW: these were in CreateProjectInput but zod silently dropped them before.
  provider: providerSchema.or(z.literal('')).optional().transform((value) => value || undefined),
  apiKey: optionalField(500),
  model: optionalField(80),
  baseUrl: optionalField(200),
  tavilyApiKey: optionalField(500),
})

const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  branchName: z.string().trim().max(80).nullable().optional(),
  context: z.string().trim().max(500).optional(),
})



const safeProject = (project: Prisma.ProjectGetPayload<object>): ProjectView => ({
  id: project.id,
  name: project.name,
  repositoryUrl: sanitizeRepoUrl(project.repo_url),
  branchName: project.branch_name,
  context: project.context,
  sandboxStatus: project.sandbox_status,
  provisionStatus: project.provision_status,
  provisionError: project.provision_error ? 'Project setup failed' : null,
  hasRepositoryToken: Boolean(project.github_token),
  createdAt: project.created_at,
  updatedAt: project.updated_at,
})

// hasUsableCredentials now lives in ../credentials (one definition, used everywhere).





export async function listProjects(): Promise<ActionResult<ProjectListItem[]>> {
  try {
    const projects = await prisma.project.findMany({ orderBy: { updated_at: 'desc' } })
    const items = await Promise.all(
      projects.map(async (project) => ({
        ...safeProject(project),
        hasCredentials: hasUsableCredentials(await readProjectCredentials(project.id)),
      }))
    )
    return { ok: true, data: items }
  } 
  catch (error) {
    return actionFailure('List projects', error instanceof Error ? error.message : 'Failed to load projects')
  }
}





export async function createProject(input: CreateProjectInput): Promise<ActionResult<ProjectListItem>> {

  // 1. Validate everything BEFORE touching the DB.
  const parsed = createProjectSchema.safeParse(input)
  if (!parsed.success) return actionFailure('Create project', 'Project details are invalid', ErrorCode.TOOL_EXECUTION_FAILED)

  const cleanInput = parsed.data
  const repoUrl = sanitizeRepoUrl(cleanInput.repositoryUrl)
  if (!isCleanGitHubRepoUrl(repoUrl)) {
    return actionFailure('Create project', 'Repository URL must look like https://github.com/owner/repo')
  }

  const branchProblem = cleanInput.branchName ? workingBranchProblem(cleanInput.branchName) : null
  if (branchProblem) return actionFailure('Create project', branchProblem)

  const credentialValues: Record<string, string> = {}
  if (cleanInput.provider) credentialValues.provider = cleanInput.provider
  if (cleanInput.apiKey) credentialValues.apiKey = cleanInput.apiKey
  if (cleanInput.model) credentialValues.model = cleanInput.model
  if (cleanInput.baseUrl) credentialValues.baseUrl = cleanInput.baseUrl
  if (cleanInput.tavilyApiKey) credentialValues.tavilyApiKey = cleanInput.tavilyApiKey

  // Same rules as saveProjectCredentials: validate BEFORE creating anything.
  const credentials = normalizeCredentials(credentialValues)
  const problem = credentialsProblem({
    ...credentials,
    ...(cleanInput.repositoryToken ? { repositoryToken: cleanInput.repositoryToken } : {}),
  })
  if (problem) return actionFailure('Create project', problem)

  // 2. Create the record only (fast). Token is encrypted here, once, at the boundary.
  //    encrypt() runs before create(): if the key is missing, no row is created.
  let project: Prisma.ProjectGetPayload<object>
  try {
    project = await prisma.project.create({
      data: {
        name: cleanInput.name,
        repo_url: repoUrl,
        branch_name: cleanInput.branchName ?? null,
        context: cleanInput.context ?? '',
        github_token: cleanInput.repositoryToken ? encrypt(cleanInput.repositoryToken) : null,
        provision_status: 'PENDING',
      },
    })
  } 
  catch (error) {
    return actionFailure('Create project', error instanceof Error ? error.message : 'Failed to create project')
  }

  // 3. Save LLM credentials (encrypted). If this fails, undo the row: no half-created project.
  if (Object.keys(credentials).length > 0) {
    try {
      await writeProjectCredentials(project.id, credentials)
    } catch (error) {
      await prisma.project.delete({ where: { id: project.id } }).catch(() => null)
      return actionFailure('Create project', error instanceof Error ? error.message : 'Failed to save credentials')
    }
  }

  // 4. Slow work (docker image/container/clone) runs in the background.
  //    provisionSandbox never rejects, but .catch keeps a crash from ever
  //    becoming an unhandled rejection. UI polls getSandboxStatus for progress.
  void provisionSandbox(project.id).catch((error) => {
    console.error('Background provisioning crashed', { projectId: project.id, error })
  })

  return {
    ok: true,
    data: {
      ...safeProject(project),
      hasCredentials: hasUsableCredentials(credentials),
    },
  }
}





export async function updateProject(id: string, input: UpdateProjectInput) {
  const cleanId = id.trim()

  const parsed = updateProjectSchema.safeParse(input)
  if (!parsed.success) return actionFailure('Update project', 'Project update data is invalid', ErrorCode.TOOL_EXECUTION_FAILED)

  const branchProblem = parsed.data.branchName ? workingBranchProblem(parsed.data.branchName) : null
  if (branchProblem) return actionFailure('Update project', branchProblem)
  

  const updateData: Record<string, string | null> = {}
  if (parsed.data.name !== undefined) updateData.name = parsed.data.name
  if (parsed.data.branchName !== undefined) updateData.branch_name = parsed.data.branchName ?? null
  if (parsed.data.context !== undefined) updateData.context = parsed.data.context

  try {
    const project = await prisma.project.update({
      where: { id: cleanId },
      data: updateData,
    })

    return { ok: true, data: safeProject(project) }
  } 
  catch (error) { return actionFailure('Update project', error instanceof Error ? error.message : 'Failed to update project')}
}





// Delete = stop the agent, remove the container, then remove the data.
// Order matters: the container goes FIRST. If we deleted the database row first and
// the container removal then failed, nothing would remember the container any more (an orphan).
export async function deleteProject(
  id: string,
  options: { force?: boolean } = {}
): Promise<ActionResult<undefined>> {
  const cleanId = id.trim()
  if (!cleanId) return actionFailure('Delete project', 'Project id is invalid', ErrorCode.TASK_NOT_FOUND)

  try {
    const project = await prisma.project.findUnique({
      where: { id: cleanId },
      select: { active_run_id: true, provision_status: true },
    })
    if (!project) return { ok: true, data: undefined } // already gone: deleting twice is harmless

    if (project.provision_status === 'PROVISIONING') {
      return actionFailure('Delete project', 'Setup is still in progress. Try again when it finishes.')
    }

    // Same confirmation pattern as Stop / Destroy: the UI shows its "Hard stop" popup on this code.
    if (project.active_run_id) {
      if (options?.force !== true) {
        return actionFailure(
          'Delete project',
          'An agent run is still active. Hard stop the run to continue, or cancel.',
          ErrorCode.TASK_ALREADY_RUNNING
        )
      }
      await cancelRun(project.active_run_id) // guarantees the run is finished
    }

    // Visible marker; provisionSandbox refuses to start a sandbox while this is set.
    await prisma.project.update({ where: { id: cleanId }, data: { sandbox_status: 'DESTROYING' } })

    const destroyed = await containers.destroy(cleanId)
    if (!destroyed.ok) {
      await prisma.project.update({ where: { id: cleanId }, data: { sandbox_status: 'STOPPED' } }).catch(() => null)
      return actionFailure(
        'Delete project',
        'Could not remove the project sandbox. Make sure Docker is running, then try again.',
        ErrorCode.CONTAINER_EXEC_FAILED
      )
    }

    // Database side in ONE transaction: encrypted credentials + the project
    // (conversations, messages, runs and logs go with it through cascade).
    await prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: cleanId }, data: { active_run_id: null } })
      await deleteProjectCredentials(cleanId, tx)
      await tx.project.delete({ where: { id: cleanId } })
    })

    return { ok: true, data: undefined }
  }
  catch (error) {
    return actionFailure('Delete project', error instanceof Error ? error.message : 'Failed to delete project')
  }
}
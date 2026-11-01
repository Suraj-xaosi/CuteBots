'use server'

import { prisma, type Prisma } from '@workspace/db'
import { ErrorCode, type ActionResult, type CreateProjectInput, type ProjectListItem, type ProjectView, type UpdateProjectInput } from '@workspace/types'
import { z } from 'zod'
import { provisionSandbox } from '../sandbox-service'
import { actionFailure } from '../action-utils'
import { encrypt, readProjectCredentials, writeProjectCredentials } from '../credentials'
import { isCleanGitHubRepoUrl, providerSchema, sanitizeRepoUrl } from '../safe'



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

// "Usable" = the agent could actually call an LLM. (Not the same as repo token.)
const hasUsableCredentials = (credentials: Record<string, string> | null) =>
 // Boolean(credentials?.provider && (credentials.apiKey || credentials.provider === 'ollama'))
  Boolean(credentials?.provider && credentials.apiKey )




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

  const credentialValues: Record<string, string> = {}
  if (cleanInput.provider) credentialValues.provider = cleanInput.provider
  if (cleanInput.apiKey) credentialValues.apiKey = cleanInput.apiKey
  if (cleanInput.model) credentialValues.model = cleanInput.model
  if (cleanInput.baseUrl) credentialValues.baseUrl = cleanInput.baseUrl
  if (cleanInput.tavilyApiKey) credentialValues.tavilyApiKey = cleanInput.tavilyApiKey

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
  if (Object.keys(credentialValues).length > 0) {
    try {
      await writeProjectCredentials(project.id, credentialValues)
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
      hasCredentials: hasUsableCredentials(credentialValues),
    },
  }
}





export async function updateProject(id: string, input: UpdateProjectInput) {
  const cleanId = id.trim()

  const parsed = updateProjectSchema.safeParse(input)
  if (!parsed.success) return actionFailure('Update project', 'Project update data is invalid', ErrorCode.TOOL_EXECUTION_FAILED)
  

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





// NOTE: deleteProject is intentionally unchanged for now.
// It leaves the Docker container and credentials behind (orphans) -> fixed in the delete lesson.
export async function deleteProject(id: string): Promise<ActionResult<undefined>> {
  try {
    await prisma.project.delete({ where: { id: id.trim() } })
    return { ok: true, data: undefined }
  } 
  catch (error) {return actionFailure('Delete project', error instanceof Error ? error.message : 'Failed to delete project')}
}
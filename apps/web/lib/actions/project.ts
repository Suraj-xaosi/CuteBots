'use server'

import { prisma, type Prisma } from '@workspace/db'
import { ErrorCode, type ActionResult, type CreateProjectInput, type ProjectListItem, type ProjectView, type UpdateProjectInput } from '@workspace/types'
import { z } from 'zod'
import { provisionSandbox } from '../sandbox-service'
import { actionFailure } from '../action-utils'
import { sanitizeRepoUrl } from '../safe'

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(100),
  repositoryUrl: z.string().trim().min(1).max(400),
  branchName: z.string().trim().max(80).optional().or(z.literal('')).transform((value) => value?.trim() || undefined),
  context: z.string().trim().max(500).optional().or(z.literal('')).transform((value) => value?.trim() ?? ''),
  repositoryToken: z.string().trim().max(500).optional().or(z.literal('')).transform((value) => value?.trim() || undefined),
})

const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  branchName: z.string().trim().max(80).nullable().optional(),
  context: z.string().trim().max(500).optional(),
})

export const safeProject = (project: Prisma.ProjectGetPayload<object>): ProjectView => ({
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

export async function listProjects(): Promise<ActionResult<ProjectListItem[]>> {
  try {
    const projects = await prisma.project.findMany({ orderBy: { updated_at: 'desc' } })
    return { ok: true, data: projects.map((project) => ({ ...safeProject(project), hasCredentials: false })) }
  } catch (error) {
    return actionFailure('List projects', error instanceof Error ? error.message : 'Failed to load projects')
  }
}

export async function createProject(
  input: CreateProjectInput
): Promise<ActionResult<ProjectListItem>> {
  const parsed = createProjectSchema.safeParse(input)
  if (!parsed.success) {
    return actionFailure('Create project', 'Project details are invalid', ErrorCode.TOOL_EXECUTION_FAILED)
  }

  const cleanInput = parsed.data
  const repoUrl = sanitizeRepoUrl(cleanInput.repositoryUrl)

  try {
    const project = await prisma.project.create({
      data: {
        name: cleanInput.name,
        repo_url: repoUrl,
        branch_name: cleanInput.branchName ?? null,
        context: cleanInput.context ?? '',
        github_token: cleanInput.repositoryToken ?? null,
      },
    })

    await provisionSandbox(project.id)

    return {
      ok: true,
      data: {
        ...safeProject(project),
        hasCredentials: Boolean(cleanInput.repositoryToken),
      },
    }
  } catch (error) {
    return actionFailure('Create project', error instanceof Error ? error.message : 'Failed to create project')
  }
}

export async function updateProject(id: string, input: UpdateProjectInput) {
  const cleanId = id.trim()
  const parsed = updateProjectSchema.safeParse(input)
  if (!parsed.success) {
    return actionFailure('Update project', 'Project update data is invalid', ErrorCode.TOOL_EXECUTION_FAILED)
  }

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
  } catch (error) {
    return actionFailure('Update project', error instanceof Error ? error.message : 'Failed to update project')
  }
}

export async function deleteProject(id: string): Promise<ActionResult<undefined>> {
  try {
    await prisma.project.delete({ where: { id: id.trim() } })
    return { ok: true, data: undefined }
  } catch (error) {
    return actionFailure('Delete project', error instanceof Error ? error.message : 'Failed to delete project')
  }
}


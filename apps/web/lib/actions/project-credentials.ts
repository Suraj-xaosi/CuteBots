'use server'

import { prisma } from '@workspace/db'
import type { ActionResult, ProjectCredentialsView } from '@workspace/types'
import { encrypt, readProjectCredentials, writeProjectCredentials } from '../credentials'

export async function getProjectCredentials(id: string): Promise<ActionResult<ProjectCredentialsView>> {

  const project = await prisma.project.findUnique({ where: { id },select: { github_token: true }, })

  if (!project) return { ok: false, error: 'Project not found' }

  const credentials = await readProjectCredentials(id)
  if (!credentials) return { ok:false,error:"i dont know what to write here "}

  const data: ProjectCredentialsView = {
    provider: (credentials.provider ?? '') as ProjectCredentialsView['provider'],
    model: credentials.model ?? '',
    baseUrl: credentials.baseUrl ?? '',
    hasApiKey: Boolean(credentials.apiKey),
    hasTavilyApiKey: Boolean(credentials.tavilyApiKey),
    hasRepositoryToken: Boolean(project.github_token),
  }

  return { ok: true, data }
}

export async function saveProjectCredentials(id: string,input: any): Promise<ActionResult<{ saved: true }>> {
  const credData:any={}
  if(input.provider !== undefined) credData.provider=input.provider;
  if(input.apiKey!==undefined) credData.apikey=input.apiKey
  if(input.model!==undefined) credData.model=input.model
  if(input.baseUrl!==undefined)credData.baseUrl=input.baseUrl
  if(input.tavilyApiKey!==undefined)credData.tavilyApiKey=input.tavilyApiKey

  await writeProjectCredentials(id,credData)

  if (input.repositoryToken?.trim()) {
    await prisma.project.update(
      {
        where: { id },
        data: { github_token: encrypt(input.repositoryToken.trim()) },
      }
    )
  }

  return { ok: true, data: { saved: true } }
}

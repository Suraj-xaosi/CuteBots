"use server"

import { prisma } from "@workspace/db"
import type {
  ActionResult,
  CreateProjectInput,
  ProjectListItem,
  ProjectView,
  UpdateProjectInput,
} from "@workspace/types"

import { provisionSandbox } from "../sandbox-service"
import type { Prisma } from "@workspace/db"


const safeRepositoryUrl=(value:string )=>{
    try{
        const url = new URL(value);
        return `${url.origin}${url.pathname}`
    }catch{return ""}
    
}

export const safeProject = ( project: Prisma.ProjectGetPayload<object>): ProjectView => (
    {
        id: project.id,
        name: project.name,
        repositoryUrl: safeRepositoryUrl(project.repo_url),
        branchName: project.branch_name,
        context: project.context,
        sandboxStatus: project.sandbox_status,
        provisionStatus: project.provision_status,
        provisionError: project.provision_error ? "Project setup failed" : null,
        hasRepositoryToken: Boolean(project.github_token),
        createdAt: project.created_at,
        updatedAt: project.updated_at,
    }
)




export async function listProjects():Promise<ActionResult<ProjectListItem[]>>{
    try{
        const projects= await prisma.project.findMany({ orderBy:{updated_at:"desc"}})
        return {
            ok:true,
            data:projects.map((project)=>({...safeProject(project),hasCredentials:false}))
        }
    }
    catch{  return{ok:false,error:"Failed to load projects"}    }
}

export async function createProject(input:CreateProjectInput):Promise<ActionResult<ProjectListItem>>{

    let url = input.repositoryUrl.trim();
    if (url.endsWith(".git")) url = url.slice(0, -4);

    const repo_url = url;

    try{
        const project= await prisma.project.create(
            {
                data:{
                    name:input.name.trim(),
                    repo_url,
                    branch_name:input.branchName?.trim()|| null,
                    context:input.context?.trim()??"",
                    github_token:input.repositoryToken?.trim()||null,
                }
            }
        )
        await provisionSandbox(project.id);

        return {
            ok: true,
            data: {
                ...safeProject(project),
                hasCredentials: Boolean(input.provider || input.apiKey),
            },
        }

    }catch{ return {ok:false,error:"Failed to create project"}  }
}

export async function updateProject(id: string, input: UpdateProjectInput) {
  const updateData: any = {};

  if (input.name !== undefined) updateData.name = input.name.trim();
  if (input.branchName !== undefined) updateData.branch_name = input.branchName?.trim() || null;
  if (input.context !== undefined) updateData.context = input.context.trim();

  try {

    const project = await prisma.project.update( { where:{ id }, data: updateData, });

    return { ok: true, data: safeProject(project) };

  } catch {
    return { ok: false, error: "Failed to update project" };
  }
}

export async function deleteProject(id:string):Promise<ActionResult<undefined>>{
    try{
        await prisma.project.delete({where:{id}})
        return{ok:true,data:undefined}

    }catch{ return{ok:false,error:"Failed to delete project"}}
}

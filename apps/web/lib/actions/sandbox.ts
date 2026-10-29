
"use server"

import path from "node:path"
import {prisma} from "@workspace/db"
import { ProjectProvisionStatus,SandboxStatus,type ActionResult,type SandboxStatusView } from "@workspace/types"
import { containers } from "../agent-runtime"
import { provisionSandbox } from "../sandbox-service"


const workspace='/workspace'

export async function openSandbox(projectId:string):Promise<ActionResult<any>>{

    const project=await prisma.project.findUnique(
        {
            where:{id:projectId},
            select:{sandbox_status:true}
        }
    )
    if(!project) return {ok:false,error:"Project not found"}
    
    const attached=containers.get(projectId);
    if(attached.ok) return attached;
    
    const recovered=await containers.recover(projectId);
    if(recovered.ok) return containers.get(projectId)
    
    return{ok:false,error:"Unable to access project sandbox"}
    
}



export async function getSandboxStatus(projectId:string):Promise<ActionResult<SandboxStatusView>>{
    const project= await prisma.project.findUnique(
        {
            where:{id:projectId},
            select:{
                sandbox_status:true,
                provision_status:true,
                provision_error:true
            }
        }
    )

    if(!project) return {ok:false,error:"project not found"}

    const data:SandboxStatusView={
        status:project.sandbox_status,
        provisionStatus:project.provision_status,
        error:project.provision_error?"project setup failed":null
    }

    return{ok:true,data}
}



export async function startSandbox(projectId:string):Promise<ActionResult<{status:String;provisionStatus:string}>>{

    const result=await provisionSandbox(projectId)
    if(result.ok) return {ok:true,data:{status:SandboxStatus.RUNNING,provisionStatus:ProjectProvisionStatus.READY}}
    return result as ActionResult<{status:string; provisionStatus:string}>

}



export async function stopSandbox(projectId: string): Promise<ActionResult<{ status: string }>> {

    const result=containers.stop(projectId);
    if (!result.ok) return { ok: false, error: 'Unable to stop project sandbox' }
    await prisma.project.update(
        {
            where:{id:projectId},
            data:{sandbox_status:'STOPPED',container_id:null}  //to do : daugt is should container id be null here while stopping the container ??. what if user wants to restart it after stopping it 
        }
    )
    return {ok:true, data:{status:'STOPPED'}}

}



export async function listProjectFiles(projectId:string,directory="."):Promise<ActionResult<any>> {
    const result = await openSandbox(projectId)
    if(!result.ok) return result
    
    const listing=await result.data.exec(`ls -la ${directory}`)
    if(!listing.ok) return {ok:false,error:"unable to list Project Files"}
    return{
        ok:true,
        data:{
            entries:[{
                name:path.basename(directory),
                path:directory,
                type:'directory',
                size:0,
                modifiedAt:Date.now()
            }],
            hasmore:false
        }
    }
}



export async function readProjectFile(projectId: string, filePath: string): Promise<ActionResult<any>> {
  const result = await openSandbox(projectId)
  if (!result.ok) return result

  const content = await result.data.readFile(filePath)
  if (!content.ok) return { ok: false, error: 'Unable to read project file' }

  return {
    ok: true,
    data: {
      path: filePath,
      size: content.data.length,
      content: content.data,
    },
  }
}

import "server-only"

import { cloneGitHubRepository} from "@workspace/core"
import {prisma} from "@workspace/db"
import { decrypt } from "./credentials"
import {containers} from "./agent-runtime"
import {ActionResult} from "@workspace/types"

export async function provisionSandbox(projectId:string):Promise<ActionResult<any>>{
    try{
        const project=await prisma.project.findUnique( { where:{id:projectId} } )
        if(!project) return {ok:false,error:"Project not found"}

        let sandboxResult=containers.get(projectId);
        if(!sandboxResult.ok){
            const recovered=await containers.recover(projectId);
            if(recovered.ok){sandboxResult=containers.get(projectId)}
            else {sandboxResult=await containers.create(projectId);}

        }
        if(!sandboxResult.ok) return {ok:false,error:"Failed during container setup"}
        
        if(project.repo_url){
            const clone=await cloneGitHubRepository(
                sandboxResult.data,
                project.repo_url,
                project.id,project.github_token?decrypt(project.github_token):undefined
            )
            
            if(!clone.success){
                await prisma.project.update(
                    {
                        where:{id:projectId},
                        data:{
                            provision_status:"FAILED",
                            provision_error:clone.output
                        }
                    }
                )
                return{ ok:false,error:clone.output }
            }
        }

        await prisma.project.update(
            {
                where: { id: projectId },
                data: {
                    container_id: sandboxResult.data.getId(),
                    sandbox_status: "RUNNING",
                    provision_status: "READY",
                    provision_error: null,
                },
            }
        )
        return{ok:true,data:sandboxResult.data}

    }catch{ return{ok:false,error:"provision Sandbox failed"}}
    
    
}
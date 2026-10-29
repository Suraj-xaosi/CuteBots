import "server-only"
import { createCipheriv,createDecipheriv,randomBytes } from "node:crypto"
import {prisma} from "@workspace/db"


function encryptionKey(){
    const key= process.env.CREDENTIALS_ENCRYPTION_KEY
    const decoded =key? Buffer.from(key,"base64"):Buffer.alloc(0)
    if(!key|| decoded.length!==32){
        throw new Error(
            "Configure CREDENTIALS_ENCCRYPTION_KEY as a 32-byte base key "
        )
    }
    return decoded
}





export function encrypt(text:string){
    const iv = randomBytes(12);
    const cipher =createCipheriv("aes-256-gcm",encryptionKey(),iv)
    const encrypted=Buffer.concat([cipher.update(text,"utf8"),cipher.final()])
    return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString("base64")
}




export function decrypt(text:string){
    const data= Buffer.from(text,"base64")
    if(data.length<28) throw new Error("Stored credntials are invalid")

    const decipher=createDecipheriv(
        "aes-256-gcm",
        encryptionKey(),
        data.subarray(0,12)
    )   
    decipher.setAuthTag(data.subarray(12,28))
    return Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
    ]).toString("utf-8")
}





export async function readProjectCredentials(projectId:string){
    const setting=await prisma.setting.findUnique(  {where:{ key:`project:${projectId}:credentials`}   }   )
    if(!setting) return;

    const values:unknown=JSON.parse(decrypt(setting.value))
    if(typeof values !== "object"|| values==null|| Array.isArray(values)){
        throw new Error("Stored project credentials are invalid")
    }

    return Object.fromEntries(
        Object.entries(values).filter(
            (entry):entry is [string,string]=>typeof entry[1] ==="string"
        )
    )
}




export async function writeProjectCredentials(projectId: string,values: Record<string, string>){

  const existing = await readProjectCredentials(projectId)
  const credentials = { ...existing }

  for (const [key, value] of Object.entries(values)) {
    if (value.trim()) credentials[key] = value.trim()
  }

  const key = `project:${projectId}:credentials`
  await prisma.setting.upsert(
    {
        where: { key },
        create: {
            key,
            value: encrypt(JSON.stringify(credentials)),
            is_secret: true,
        },
        update: { value: encrypt(JSON.stringify(credentials)), is_secret: true },
    }
  )

  return credentials
}
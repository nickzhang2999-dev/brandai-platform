import {prisma} from '@brandai/db';
import type {InspirationActivity} from '@brandai/contracts';
import {inspirationEnabled} from './config';

/** Private read-only metadata projection. Worker/getChat persist deadline failures; polling never runs or retries work. */
export async function listInspirationActivity(workspaceId:string,userId:string,now=new Date()):Promise<InspirationActivity> {
  if(!inspirationEnabled())return {enabled:false,items:[]};
  if(!workspaceId||!userId)return {enabled:true,items:[]};
  const rows=await prisma.inspirationChat.findMany({where:{workspaceId,userId,OR:[{status:{in:['PENDING','RUNNING']}},{updatedAt:{gte:new Date(now.getTime()-30*60000)}}]},
    select:{id:true,workspaceId:true,userId:true,conversationId:true,status:true,createdAt:true,updatedAt:true,expiresAt:true},orderBy:{createdAt:'desc'},take:20});
  return {enabled:true,items:rows.filter(row=>row.workspaceId===workspaceId&&row.userId===userId&&['PENDING','RUNNING','SUCCEEDED','FAILED'].includes(row.status)).map(row=>{
    const expired=['PENDING','RUNNING'].includes(row.status)&&row.expiresAt<=now;
    return {id:row.id,conversationId:row.conversationId,status:expired?'FAILED':row.status,createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),expiresAt:row.expiresAt.toISOString(),expired};
  })};
}

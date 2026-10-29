import { prisma } from '@brandai/db';
import { ApiException, handleError, ok, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
import { requireEnabled } from '@/lib/inspiration/service';
import { syncConfigured } from '@/lib/inspiration/config';
import { lockWorkspace } from '@/lib/inspiration/replica';
export async function POST(_req:Request,{params}:{params:Promise<{wsId:string}>}) {
  try {const user=await requireUser(),{wsId}=await params;await requireWorkspaceRole(wsId,user.id,'OWNER');requireEnabled();if(!syncConfigured())throw new ApiException(503,'知识发布连接尚未配置。');
    const task=await prisma.$transaction(async tx=>{await lockWorkspace(tx,wsId);await tx.inspirationState.upsert({where:{workspaceId:wsId},create:{workspaceId:wsId},update:{}});
      const existing=await tx.asyncTask.findFirst({where:{workspaceId:wsId,kind:'INSPIRATION_SYNC',status:{in:['PENDING','RUNNING']},expiresAt:{gt:new Date()}}});return existing ?? tx.asyncTask.create({data:{workspaceId:wsId,kind:'INSPIRATION_SYNC',expiresAt:new Date(Date.now()+6*60000)}});});
    return ok({id:task.id,status:task.status},{status:202});
  }catch(e){return handleError(e);}
}

import { prisma } from '@brandai/db';
import { ApiException, handleError, ok, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
export async function POST(_req:Request,{params}:{params:Promise<{wsId:string;id:string}>}) {
  try {const user=await requireUser(),{wsId,id}=await params;await requireWorkspaceRole(wsId,user.id,'EDITOR');
    const row=await prisma.inspirationChat.findFirst({where:{id,workspaceId:wsId,userId:user.id}});if(!row)throw new ApiException(404,'对话不存在。');
    await prisma.$transaction(async tx=>{await tx.inspirationChat.updateMany({where:{id,workspaceId:wsId,userId:user.id,status:{in:['PENDING','RUNNING']}},data:{status:'FAILED',error:'用户取消了本轮回答。'}});await tx.asyncTask.updateMany({where:{id,workspaceId:wsId,kind:'INSPIRATION_CHAT',status:{in:['PENDING','RUNNING']}},data:{status:'FAILED',error:'用户取消了本轮回答。'}});});
    return ok({id,cancelled:true});
  }catch(e){return handleError(e);}
}

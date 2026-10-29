import { prisma } from '@brandai/db';
import { ApiException, handleError, ok, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
export async function DELETE(_req:Request,{params}:{params:Promise<{wsId:string;id:string}>}) {
  try {const user=await requireUser(),{wsId,id}=await params;await requireWorkspaceRole(wsId,user.id,'EDITOR');const result=await prisma.inspirationBookmark.deleteMany({where:{workspaceId:wsId,userId:user.id,id}});if(!result.count)throw new ApiException(404,'收藏不存在。');return ok({deleted:true});}catch(e){return handleError(e);}
}

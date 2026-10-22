import { prisma } from '@brandai/db';
import { InspirationChatInput } from '@brandai/contracts';
import { ApiException, handleError, ok, parse, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
import { createChat, getChat, requireEnabled } from '@/lib/inspiration/service';
export async function POST(req:Request,{params}:{params:Promise<{wsId:string}>}) {
  try {const user=await requireUser(),{wsId}=await params;await requireWorkspaceRole(wsId,user.id,'EDITOR');requireEnabled();const input=parse(InspirationChatInput,await req.json());
    const row=await createChat(wsId,user.id,input);return ok({id:row.id,conversationId:row.conversationId,status:row.status},{status:202});
  }catch(e){return handleError(e);}
}
export async function GET(req:Request,{params}:{params:Promise<{wsId:string}>}) {
  try {const user=await requireUser(),{wsId}=await params;await requireWorkspaceRole(wsId,user.id,'VIEWER');requireEnabled();const conversationId=new URL(req.url).searchParams.get('conversationId');
    if(!conversationId)throw new ApiException(400,'缺少对话标识。');const rows=await prisma.inspirationChat.findMany({where:{workspaceId:wsId,userId:user.id,conversationId},orderBy:{createdAt:'desc'},take:100});
    return ok({items:await Promise.all(rows.reverse().map(r=>getChat(wsId,user.id,r.id)))},{headers:{'Cache-Control':'no-store'}});
  }catch(e){return handleError(e);}
}

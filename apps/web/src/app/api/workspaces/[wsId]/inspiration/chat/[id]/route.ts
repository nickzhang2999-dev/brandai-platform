import { handleError, ok, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
import { getChat, requireEnabled } from '@/lib/inspiration/service';
export async function GET(_req:Request,{params}:{params:Promise<{wsId:string;id:string}>}) {
  try {const user=await requireUser(),{wsId,id}=await params;await requireWorkspaceRole(wsId,user.id,'VIEWER');requireEnabled();return ok(await getChat(wsId,user.id,id),{headers:{'Cache-Control':'no-store'}});}catch(e){return handleError(e);}
}

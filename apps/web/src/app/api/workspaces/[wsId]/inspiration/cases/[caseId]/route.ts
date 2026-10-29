import { handleError, ok, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
import { getCase, requireEnabled } from '@/lib/inspiration/service';
export async function GET(_req:Request,{params}:{params:Promise<{wsId:string;caseId:string}>}) {
  try {const user=await requireUser(),{wsId,caseId}=await params;await requireWorkspaceRole(wsId,user.id,'VIEWER');requireEnabled();return ok((await getCase(wsId,caseId)).case,{headers:{'Cache-Control':'no-store'}});}catch(e){return handleError(e);}
}

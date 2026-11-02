import { handleError, ok, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
import { getCase, requireEnabled } from '@/lib/inspiration/service';
export async function GET(req:Request,{params}:{params:Promise<{wsId:string;caseId:string}>}) {
  try {const user=await requireUser(),{wsId,caseId}=await params;await requireWorkspaceRole(wsId,user.id,'VIEWER');requireEnabled();return ok((await getCase(wsId,caseId,undefined,new URL(req.url).searchParams.get('libraryId')||undefined)).case,{headers:{'Cache-Control':'no-store'}});}catch(e){return handleError(e);}
}

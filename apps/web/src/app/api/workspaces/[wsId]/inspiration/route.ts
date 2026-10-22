import { handleError, ok, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
import { listCases } from '@/lib/inspiration/service';
export async function GET(req:Request,{params}:{params:Promise<{wsId:string}>}) {
  try { const user=await requireUser(),{wsId}=await params;await requireWorkspaceRole(wsId,user.id,'VIEWER');
    const p=new URL(req.url).searchParams;return ok(await listCases(wsId,{q:(p.get('q')??'').slice(0,300),industry:p.get('industry')??undefined,medium:p.get('medium')??undefined}),{headers:{'Cache-Control':'no-store'}});
  }catch(e){return handleError(e);}
}

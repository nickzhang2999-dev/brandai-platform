import { handleError, ok, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
import { listCases } from '@/lib/inspiration/service';
import { CATALOG_MAX_PAGE_SIZE } from '@/lib/inspiration/catalog';
import { requestedLibraryId } from '@/lib/inspiration/library-query';

/** Absent or unparsable limits fall back to the default page, never to "everything". */
function pageSize(raw: string | null) {
  const value = Number(raw);
  return raw && Number.isSafeInteger(value) && value > 0 ? Math.min(value, CATALOG_MAX_PAGE_SIZE) : undefined;
}

export async function GET(req:Request,{params}:{params:Promise<{wsId:string}>}) {
  try { const user=await requireUser(),{wsId}=await params;await requireWorkspaceRole(wsId,user.id,'VIEWER');
    const p=new URL(req.url).searchParams;
    return ok(await listCases(
      wsId,
      {q:(p.get('q')??'').slice(0,300),kind:(p.get('kind')??'').slice(0,80),industry:(p.get('industry')??'').slice(0,80),medium:(p.get('medium')??'').slice(0,80),task:(p.get('task')??'').slice(0,80)},
      requestedLibraryId(req),
      // `cursor` is the last caseId the browser already has for this exact filter
      // set; anything else would page a different ordering than it displayed.
      {limit:pageSize(p.get('limit')),cursor:(p.get('cursor')??'').slice(0,128) || null},
    ),{headers:{'Cache-Control':'no-store'}});
  }catch(e){return handleError(e);}
}

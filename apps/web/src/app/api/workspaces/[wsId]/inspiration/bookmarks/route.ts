import { prisma } from '@brandai/db';
import { InspirationBookmarkInput } from '@brandai/contracts';
import { ApiException, handleError, ok, parse, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
import { getCase, currentCases, requireEnabled } from '@/lib/inspiration/service';
export async function GET(_req:Request,{params}:{params:Promise<{wsId:string}>}) {
  try {const user=await requireUser(),{wsId}=await params;await requireWorkspaceRole(wsId,user.id,'VIEWER');requireEnabled();
    const rows=await prisma.inspirationBookmark.findMany({where:{workspaceId:wsId,userId:user.id},orderBy:{updatedAt:'desc'},take:200});
    const libraries=new Map(await Promise.all([...new Set(rows.map(r=>r.libraryId))].map(async id=>[id,await currentCases(wsId,id)] as const)));
    return ok({items:rows.map(r=>{const c=libraries.get(r.libraryId)?.cases.find(c=>c.caseId===r.caseId&&c.revision===r.revision)??null;return{id:r.id,libraryId:r.libraryId,caseId:r.caseId,revision:r.revision,projectId:r.projectId||null,note:r.note,case:c,unavailable:!c};})},{headers:{'Cache-Control':'no-store'}});
  }catch(e){return handleError(e);}
}
export async function POST(req:Request,{params}:{params:Promise<{wsId:string}>}) {
  try {const user=await requireUser(),{wsId}=await params;await requireWorkspaceRole(wsId,user.id,'EDITOR');requireEnabled();const input=parse(InspirationBookmarkInput,await req.json());const c=(await getCase(wsId,input.caseId,undefined,input.libraryId)).case;
    if(c.revision!==input.revision)throw new ApiException(409,'案例版本已更新，请刷新后收藏。');
    if(input.projectId && !await prisma.project.findFirst({where:{id:input.projectId,workspaceId:wsId}}))throw new ApiException(404,'项目不存在。');
    const row=await prisma.inspirationBookmark.upsert({where:{workspaceId_userId_libraryId_caseId_projectId:{workspaceId:wsId,userId:user.id,libraryId:c.libraryId!,caseId:input.caseId,projectId:input.projectId??''}},create:{workspaceId:wsId,userId:user.id,libraryId:c.libraryId!,caseId:input.caseId,revision:input.revision,projectId:input.projectId??'',note:input.note},update:{note:input.note,revision:input.revision}});
    return ok({id:row.id,libraryId:row.libraryId,caseId:row.caseId,revision:row.revision,projectId:row.projectId||null,note:row.note,case:c,unavailable:false});
  }catch(e){return handleError(e);}
}

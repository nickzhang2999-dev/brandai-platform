import { prisma } from '@brandai/db';
import { ApiException, handleError, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
import { getCase, requireEnabled } from '@/lib/inspiration/service';
import { PublishedCase, sha256 } from '@/lib/inspiration/protocol';
export async function GET(req:Request,{params}:{params:Promise<{wsId:string;caseId:string;imageId:string}>}) {
  try {const user=await requireUser(),{wsId,caseId,imageId}=await params;await requireWorkspaceRole(wsId,user.id,'VIEWER');requireEnabled();
    const revision=Number(new URL(req.url).searchParams.get('revision'));if(!Number.isSafeInteger(revision)||revision<1)throw new ApiException(400,'缺少图片版本。');
    const {row}=await getCase(wsId,caseId,revision),c=PublishedCase.parse(row.body),image=c.images.find(i=>i.image_id===imageId);if(!image)throw new ApiException(404,'图片不存在。');
    const file=await prisma.inspirationImage.findUnique({where:{workspaceId_releaseId_path:{workspaceId:wsId,releaseId:row.releaseId,path:image.path}}});
    if(!file || sha256(Buffer.from(file.bytes))!==file.sha256)throw new ApiException(503,'图片暂不可用。');
    return new Response(new Uint8Array(file.bytes),{headers:{'Content-Type':file.mimeType,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':'inline'}});
  }catch(e){return handleError(e);}
}

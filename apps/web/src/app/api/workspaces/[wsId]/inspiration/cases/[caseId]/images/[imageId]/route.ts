import { readInspirationImage } from '@/lib/inspiration/image-store';
import { ApiException, handleError, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
import { getCase, requireEnabled } from '@/lib/inspiration/service';
import { PublishedCase, sha256 } from '@/lib/inspiration/protocol';

// Revalidate every reuse: content and membership can be revoked.
export async function GET(req:Request,{params}:{params:Promise<{wsId:string;caseId:string;imageId:string}>}) {
  try {const user=await requireUser(),{wsId,caseId,imageId}=await params;await requireWorkspaceRole(wsId,user.id,'VIEWER');requireEnabled();
    const revision=Number(new URL(req.url).searchParams.get('revision'));if(!Number.isSafeInteger(revision)||revision<1)throw new ApiException(400,'缺少图片版本。');
    const {row,activeRelease,snapshotVersion}=await getCase(wsId,caseId,revision,new URL(req.url).searchParams.get('libraryId')||wsId),c=PublishedCase.parse(row.body),image=c.images.find(i=>i.image_id===imageId);if(!image)throw new ApiException(404,'图片不存在。');
    const file=await readInspirationImage(row,image.path,activeRelease,snapshotVersion===3);
    if(!file)throw new ApiException(503,'图片暂不可用。');
    if(sha256(Buffer.from(file.bytes))!==file.sha256)throw new ApiException(503,'图片暂不可用。');
    const etag=`"${file.sha256}"`;
    // A matching validator still needs the range/auth checks above to have passed,
    // so a stale cookie cannot read a cached body it is no longer allowed to see.
    if(req.headers.get('if-none-match')===etag) return new Response(null,{status:304,headers:{ETag:etag,'Cache-Control':'private, no-cache, must-revalidate'}});
    return new Response(new Uint8Array(file.bytes),{headers:{'Content-Type':file.mimeType,'Cache-Control':'private, no-cache, must-revalidate','ETag':etag,'X-Content-Type-Options':'nosniff','Content-Disposition':'inline'}});
  }catch(e){return handleError(e);}
}

import { prisma } from '@brandai/db';
import { ApiException, handleError, requireUser } from '@/lib/api';
import { requireWorkspaceRole } from '@/lib/workspace';
import { getCase, requireEnabled } from '@/lib/inspiration/service';
import { PublishedCase, sha256 } from '@/lib/inspiration/protocol';

/**
 * Case images are content-addressed by revision and never edited in place, so a
 * URL is immutable. Serve it with a long private cache plus a strong ETag and let
 * repeat views (and every remount of a 200-card grid) skip the body entirely.
 *
 * The stored sha256 is the integrity receipt written at install time. Recomputing
 * it on every read made each request hash the full image before streaming it; we
 * compare against a process-local memo of already-verified (library, release, path)
 * triples and only re-hash bytes we have not verified yet.
 */
const verified = new Set<string>();

export async function GET(req:Request,{params}:{params:Promise<{wsId:string;caseId:string;imageId:string}>}) {
  try {const user=await requireUser(),{wsId,caseId,imageId}=await params;await requireWorkspaceRole(wsId,user.id,'VIEWER');requireEnabled();
    const revision=Number(new URL(req.url).searchParams.get('revision'));if(!Number.isSafeInteger(revision)||revision<1)throw new ApiException(400,'缺少图片版本。');
    const {row}=await getCase(wsId,caseId,revision,new URL(req.url).searchParams.get('libraryId')||wsId),c=PublishedCase.parse(row.body),image=c.images.find(i=>i.image_id===imageId);if(!image)throw new ApiException(404,'图片不存在。');
    const file=await prisma.inspirationImage.findUnique({where:{libraryId_releaseId_path:{libraryId:row.libraryId,releaseId:row.releaseId,path:image.path}}});
    if(!file)throw new ApiException(503,'图片暂不可用。');
    const memoKey=`${row.libraryId}\u0000${row.releaseId}\u0000${image.path}\u0000${file.sha256}`;
    if(!verified.has(memoKey)) {
      if(sha256(Buffer.from(file.bytes))!==file.sha256)throw new ApiException(503,'图片暂不可用。');
      verified.add(memoKey);
    }
    const etag=`"${file.sha256}"`;
    // A matching validator still needs the range/auth checks above to have passed,
    // so a stale cookie cannot read a cached body it is no longer allowed to see.
    if(req.headers.get('if-none-match')===etag) return new Response(null,{status:304,headers:{ETag:etag,'Cache-Control':'private, max-age=31536000, immutable'}});
    return new Response(new Uint8Array(file.bytes),{headers:{'Content-Type':file.mimeType,'Cache-Control':'private, max-age=31536000, immutable','ETag':etag,'X-Content-Type-Options':'nosniff','Content-Disposition':'inline'}});
  }catch(e){return handleError(e);}
}

import { InspirationLibraryCreateInput, InspirationLibraryCreateResult } from '@brandai/contracts';
import { prisma } from '@brandai/db';
import { requireAdmin } from '@/lib/admin';
import { ApiException, handleError, ok, parse } from '@/lib/api';
import { sharedLibraryId, sourceLibrary } from '@/lib/inspiration/library';

export async function POST(request:Request) {
  try {
    await requireAdmin();const input=parse(InspirationLibraryCreateInput,await request.json());
    if(input.libraryId!==sharedLibraryId())throw new ApiException(409,'请先配置指定的公司灵感库。');
    const result=await prisma.$transaction(async tx=>{
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inspiration-library:${input.libraryId}`}))`;
      const identity=await tx.inspirationLibraryIdentity.findUnique({where:{id:input.libraryId}});
      if(identity&&identity.ownerId!==input.ownerId)throw new ApiException(409,'该库标识已绑定原所有者，不能重新分配。');
      const existing=await tx.inspirationLibrary.findUnique({where:{id:input.libraryId}});
      if(existing&&(existing.kind!=='SHARED'||existing.ownerId!==input.ownerId))throw new ApiException(409,'该库标识已属于其他范围，不能覆盖。');
      const owner=await tx.user.findUnique({where:{id:input.ownerId},select:{isActive:true}});
      if(!owner?.isActive)throw new ApiException(404,'指定的公司所有者不可用。');
      if(!identity)await tx.inspirationLibraryIdentity.create({data:{id:input.libraryId,ownerId:input.ownerId}});
      if(existing)return {sourceLibrary:sourceLibrary(existing),created:false};
      const library=await tx.inspirationLibrary.create({data:{id:input.libraryId,kind:'SHARED',ownerId:input.ownerId}});
      return {sourceLibrary:sourceLibrary(library),created:true};
    });
    return ok(InspirationLibraryCreateResult.parse(result),{status:result.created?201:200});
  }catch(error){return handleError(error);}
}

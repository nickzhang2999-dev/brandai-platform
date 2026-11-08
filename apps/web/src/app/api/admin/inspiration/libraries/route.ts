import { InspirationLibraryCreateInput, InspirationLibraryCreateResult } from '@brandai/contracts';
import { requireAdmin } from '@/lib/admin';
import { handleError, ok, parse } from '@/lib/api';
import { initializeSharedLibrary } from '@/lib/inspiration/library-setup';

export async function POST(request:Request) {
  try {
    await requireAdmin();const input=parse(InspirationLibraryCreateInput,await request.json());
    const result=await initializeSharedLibrary(input);
    return ok(InspirationLibraryCreateResult.parse(result),{status:result.created?201:200});
  }catch(error){return handleError(error);}
}

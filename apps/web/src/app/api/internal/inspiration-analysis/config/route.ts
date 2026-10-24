import { authenticate, configuration } from '@/lib/omni-analysis/service';
import { errorResponse } from '@/lib/omni-analysis/policy';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  try {await authenticate(request);return Response.json(await configuration(),{headers:{'Cache-Control':'no-store'}});}
  catch(error){return errorResponse(error);}
}

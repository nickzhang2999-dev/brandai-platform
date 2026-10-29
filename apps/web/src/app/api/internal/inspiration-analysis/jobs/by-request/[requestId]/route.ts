import { authenticate, getJobByRequest } from '@/lib/omni-analysis/service';
import { errorResponse } from '@/lib/omni-analysis/policy';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:{params:Promise<{requestId:string}>}) {
  try {await authenticate(request);return Response.json(await getJobByRequest((await context.params).requestId),{headers:{'Cache-Control':'no-store'}});}
  catch(error){return errorResponse(error);}
}

import { authenticate, submit } from '@/lib/omni-analysis/service';
import { errorResponse, readInput } from '@/lib/omni-analysis/policy';
export const runtime='nodejs';
export async function POST(request:Request) {
  try {await authenticate(request);const submitted=await submit(await readInput(request));return Response.json(submitted.job,{status:submitted.created?202:200,headers:{'Cache-Control':'no-store'}});}
  catch(error){return errorResponse(error);}
}

import { authenticate, getJobWorkflowEvidence } from '@/lib/omni-analysis/service';
import { errorResponse, OmniError } from '@/lib/omni-analysis/policy';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:{params:Promise<{jobId:string}>}) {
  try {
    await authenticate(request);
    const {jobId}=await context.params;
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(jobId))throw new OmniError(404,'job_not_found');
    return Response.json(await getJobWorkflowEvidence(jobId),{headers:{'Cache-Control':'no-store'}});
  } catch(error) {return errorResponse(error);}
}

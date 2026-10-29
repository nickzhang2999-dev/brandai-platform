import { ApiException, handleError, ok, requireUser } from '@/lib/api';
import { listInspirationFeedback, submitInspirationFeedback } from '@/lib/inspiration/feedback';
export async function GET(req:Request,{params}:{params:Promise<{wsId:string}>}) {
  try {
    const user=await requireUser(),{wsId}=await params,scope=new URL(req.url).searchParams.get('scope')||'mine';
    if(scope!=='mine'&&scope!=='review')throw new ApiException(400,'反馈范围无效。');
    return ok(await listInspirationFeedback(wsId,user.id,scope),{headers:{'Cache-Control':'no-store'}});
  }catch(error){return handleError(error);}
}
export async function POST(req:Request,{params}:{params:Promise<{wsId:string}>}) {
  try {const user=await requireUser(),{wsId}=await params;return ok(await submitInspirationFeedback(wsId,user.id,await req.json()),{status:201,headers:{'Cache-Control':'no-store'}});}
  catch(error){return handleError(error);}
}

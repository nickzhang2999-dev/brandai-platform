import { handleError, ok, requireUser } from '@/lib/api';
import { reviewInspirationFeedback } from '@/lib/inspiration/feedback';
export async function PATCH(req:Request,{params}:{params:Promise<{wsId:string;id:string}>}) {
  try {const user=await requireUser(),{wsId,id}=await params;return ok(await reviewInspirationFeedback(wsId,user.id,id,await req.json()),{headers:{'Cache-Control':'no-store'}});}
  catch(error){return handleError(error);}
}

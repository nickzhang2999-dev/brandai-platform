import {ApiException,handleError,requireUser} from '@/lib/api';
import {requireWorkspaceRole} from '@/lib/workspace';
import {listInspirationActivity} from '@/lib/inspiration/activity';
export const dynamic='force-dynamic';
export async function GET(req:Request,{params}:{params:Promise<{wsId:string}>}) {
  try {const user=await requireUser(),expected=req.headers.get('X-Novart-User');if(expected&&expected!==user.id)throw new ApiException(409,'登录账号已切换，请刷新页面。');
    const {wsId}=await params;await requireWorkspaceRole(wsId,user.id,'VIEWER');return Response.json(await listInspirationActivity(wsId,user.id),{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){const response=handleError(error);response.headers.set('Cache-Control','private, no-store');return response;}
}

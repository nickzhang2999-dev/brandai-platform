import {prisma} from '@brandai/db';
import {InspirationReceiptDailyResult} from '@brandai/contracts';
import {requireUser,ApiException} from '@/lib/api';
import {receiptErrorResponse} from '@/lib/inspiration/receipt-auth';
import {requireWorkspaceRole} from '@/lib/workspace';
import {dailyReceiptStatus} from '@/lib/inspiration/daily-receipts';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{wsId:string}>}) {
  try {const user=await requireUser(),{wsId}=await params;await requireWorkspaceRole(wsId,user.id,'VIEWER');
    const workspace=await prisma.brandWorkspace.findUnique({where:{id:wsId},select:{ownerId:true}});
    if(!workspace)throw new ApiException(404,'品牌不存在。');
    const day=new URL(request.url).searchParams.get('day')??undefined;
    return Response.json(InspirationReceiptDailyResult.parse(await dailyReceiptStatus(workspace.ownerId,day)),{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){return receiptErrorResponse(error);}
}

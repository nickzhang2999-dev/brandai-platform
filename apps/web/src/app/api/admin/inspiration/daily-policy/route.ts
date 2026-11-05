import {InspirationReceiptPolicyInput,InspirationReceiptDailyResult} from '@brandai/contracts';
import {requireAdmin} from '@/lib/admin';
import {parse} from '@/lib/api';
import {initializeDailyPolicy,promoteDailyTarget,dailyReceiptStatus} from '@/lib/inspiration/daily-receipts';
import {readReceiptJson,receiptErrorResponse} from '@/lib/inspiration/receipt-auth';
export async function POST(request:Request) {
  try {const user=await requireAdmin(),input=parse(InspirationReceiptPolicyInput,await readReceiptJson(request));
    if(input.action==='initialize')await initializeDailyPolicy(input.ownerId);
    else await promoteDailyTarget(input.ownerId,input.qualityDay,input.qualityEvidence,user.id);
    return Response.json(InspirationReceiptDailyResult.parse(await dailyReceiptStatus(input.ownerId)),{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){return receiptErrorResponse(error);}
}

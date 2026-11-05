import {InspirationReceiptDailyResult} from '@brandai/contracts';
import {authenticateReceiptReader,receiptErrorResponse} from '@/lib/inspiration/receipt-auth';
import {dailyReceiptStatus} from '@/lib/inspiration/daily-receipts';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  try {const ownerId=await authenticateReceiptReader(request),day=new URL(request.url).searchParams.get('day')??undefined;
    return Response.json(InspirationReceiptDailyResult.parse(await dailyReceiptStatus(ownerId,day)),{headers:{'Cache-Control':'no-store'}});
  }catch(error){const response=receiptErrorResponse(error);response.headers.set('Cache-Control','no-store');return response;}
}

import {InspirationReceiptPreflightInput,InspirationReceiptPreflightResult} from '@brandai/contracts';
import {parse} from '@/lib/api';
import {authenticateReceiptReader,readReceiptJson,receiptErrorResponse} from '@/lib/inspiration/receipt-auth';
import {preflightDailyReceipt} from '@/lib/inspiration/daily-receipts';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request) {
  try {const ownerId=await authenticateReceiptReader(request),input=parse(InspirationReceiptPreflightInput,await readReceiptJson(request));
    return Response.json(InspirationReceiptPreflightResult.parse(await preflightDailyReceipt(ownerId,input.sha256)),{headers:{'Cache-Control':'no-store'}});
  }catch(error){const response=receiptErrorResponse(error);response.headers.set('Cache-Control','no-store');return response;}
}

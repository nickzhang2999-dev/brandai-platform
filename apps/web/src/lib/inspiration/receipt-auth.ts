import {createHash,timingSafeEqual} from 'node:crypto';
import {prisma} from '@brandai/db';
import {ApiException,handleError} from '@/lib/api';
import {DailyReceiptError} from './daily-receipts';
export function receiptErrorResponse(error:unknown){return handleError(error instanceof DailyReceiptError?new ApiException(error.status,error.message):error);}

/** Separate read-only receiver credential. Never accepts publisher download or analysis tokens. */
export async function authenticateReceiptReader(request:Request) {
  const expected=process.env.INSPIRATION_RECEIPT_TOKEN_SHA256??'',ownerId=process.env.INSPIRATION_RECEIPT_OWNER_ID??'';
  if(!/^[a-f0-9]{64}$/.test(expected)||!ownerId)throw new ApiException(503,'receipt_reader_not_configured');
  const supplied=request.headers.get('authorization')??'';
  if(!/^Bearer [A-Za-z0-9._~+\/-]{32,512}={0,2}$/.test(supplied)||!timingSafeEqual(createHash('sha256').update(supplied.slice(7)).digest(),Buffer.from(expected,'hex')))throw new ApiException(401,'unauthorized');
  const owner=await prisma.user.findUnique({where:{id:ownerId},select:{isActive:true}});
  if(!owner?.isActive)throw new ApiException(403,'receipt_owner_inactive');
  return ownerId;
}
export async function readReceiptJson(request:Request) {
  const max=80_000;
  if(Number(request.headers.get('content-length')??0)>max||!request.body)throw new ApiException(413,'request_too_large');
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw new ApiException(413,'request_too_large');chunks.push(value);}}
  catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new ApiException(400,'invalid_json');}
}

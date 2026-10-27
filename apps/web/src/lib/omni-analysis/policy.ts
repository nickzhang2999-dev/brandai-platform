import { createHash, timingSafeEqual } from 'node:crypto';
import { OmniAnalysisInput, OmniAnalysisResult } from '@brandai/contracts';
import type { ProviderConfig } from '../settings';

export const OMNI_KIND = 'OMNI_INSPIRATION_ANALYSIS';
export const OMNI_TTL_MS = 6 * 60_000;
export const OMNI_FAL_OPENROUTER_BASE = 'https://fal.run/openrouter/router/openai/v1';
export function validModelId(model:string) {
  return model.length>0&&model.length<=200&&/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)
    &&!model.includes('..')&&!model.includes('//');
}
export function falQwenModel(model:string) {return validModelId(model)&&/^qwen\/qwen[a-z0-9._:-]+$/i.test(model);}
export class OmniError extends Error { constructor(public status:number, public reason:string) { super(reason); } }
export function serviceConfig() {
  const tokenHash=process.env.OMNI_ANALYSIS_TOKEN_SHA256 || '';
  const workspaceId=process.env.OMNI_ANALYSIS_WORKSPACE_ID || '';
  const userId=process.env.OMNI_ANALYSIS_USER_ID || '';
  const raw=process.env.OMNI_ANALYSIS_DAILY_LIMIT || '0';
  // Only this explicit value removes the daily cap. Zero/missing/invalid stays off.
  const dailyLimit=raw==='unlimited' ? null : /^\d{1,5}$/.test(raw) ? Number(raw) : 0;
  return {tokenHash,workspaceId,userId,dailyLimit};
}
export function checkToken(headers:Headers) {
  const c=serviceConfig(), supplied=headers.get('authorization') || '';
  if(!/^[a-f0-9]{64}$/.test(c.tokenHash) || !c.workspaceId || !c.userId) throw new OmniError(503,'service_not_configured');
  if(!/^Bearer [A-Za-z0-9._~+\/-]{32,512}={0,2}$/.test(supplied)) throw new OmniError(401,'unauthorized');
  const hash=createHash('sha256').update(supplied.slice(7)).digest();
  if(!timingSafeEqual(hash,Buffer.from(c.tokenHash,'hex'))) throw new OmniError(401,'unauthorized');
  return c;
}
export function providerReady(c:ProviderConfig) {
  if(!c.apiKey || !c.model.trim() || c.model.length>200 || !c.baseUrl) return false;
  // The fal credential is only allowed at this official, fixed compatibility URL.
  if(c.provider==='fal-openrouter')return c.baseUrl===OMNI_FAL_OPENROUTER_BASE&&falQwenModel(c.model);
  if(!['http','openai','qwen','dashscope'].includes(c.provider))return false;
  try {const u=new URL(c.baseUrl);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash;} catch {return false;}
}
export function checkedInput(raw:unknown) {
  const parsed=OmniAnalysisInput.safeParse(raw);
  if(!parsed.success)throw new OmniError(422,'invalid_input');
  const bytes=Buffer.from(parsed.data.image_base64,'base64');
  if(bytes.length>1024*1024 || bytes.length<4 || bytes.toString('base64')!==parsed.data.image_base64 || bytes[0]!==255 || bytes[1]!==216 || bytes[2]!==255)throw new OmniError(422,'invalid_jpeg');
  return parsed.data;
}
export function payloadHash(input:OmniAnalysisInput) { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }
export function requestRef(workspaceId:string,userId:string,requestId:string) {return 'omni:'+createHash('sha256').update(JSON.stringify([workspaceId,userId,requestId])).digest('hex');}
export function jobView(task:{id:string;status:string;error:string|null;resultJson:unknown}) {
  const status=({PENDING:'queued',RUNNING:'running',SUCCEEDED:'completed',FAILED:'failed'} as const)[task.status as 'PENDING'|'RUNNING'|'SUCCEEDED'|'FAILED'] ?? 'failed';
  const result=status==='completed'?OmniAnalysisResult.safeParse(task.resultJson):null;
  if(status==='completed'&&!result?.success)return {id:task.id,status:'failed' as const,reason:'invalid_stored_result'};
  return {id:task.id,status,reason:status==='failed'?(task.error || 'analysis_failed'):'',...(result?.success?{result:result.data}:{})};
}
export async function readInput(request:Request) {
  const max=2*1024*1024;
  if(Number(request.headers.get('content-length')||0)>max || !request.body)throw new OmniError(413,'request_too_large');
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw new OmniError(413,'request_too_large');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  try{return checkedInput(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(e){if(e instanceof OmniError)throw e;throw new OmniError(422,'invalid_input');}
}
export function errorResponse(error:unknown) {return Response.json({reason:error instanceof OmniError?error.reason:'service_unavailable'},{status:error instanceof OmniError?error.status:503,headers:{'Cache-Control':'no-store'}});}

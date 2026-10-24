import { prisma, type Prisma } from '@brandai/db';
import { OmniAnalysisInput } from '@brandai/contracts';
import { getEffectiveAiSettings } from '../settings';
import { checkToken, serviceConfig, providerReady, OmniError, OMNI_KIND, OMNI_TTL_MS, payloadHash, requestRef, jobView } from './policy';

type Db = Pick<Prisma.TransactionClient,'membership'|'brandWorkspace'|'user'>;
export async function activeScope(db:Db=prisma) {
  const c=serviceConfig();
  if(!c.workspaceId||!c.userId)throw new OmniError(503,'service_not_configured');
  const [user,ws,membership]=await Promise.all([
    db.user.findFirst({where:{id:c.userId,isActive:true},select:{id:true}}),
    db.brandWorkspace.findFirst({where:{id:c.workspaceId,owner:{isActive:true}},select:{ownerId:true}}),
    db.membership.findUnique({where:{userId_workspaceId:{userId:c.userId,workspaceId:c.workspaceId}},select:{role:true}}),
  ]);
  if(!user||!ws||!(ws.ownerId===c.userId||['OWNER','ADMIN','EDITOR'].includes(membership?.role || '')))throw new OmniError(403,'scope_forbidden');
  return c;
}
export async function authenticate(request:Request) {checkToken(request.headers);return activeScope();}
export async function configuration() {
  const c=serviceConfig(),vlm=(await getEffectiveAiSettings()).vlm;
  const state=!c.dailyLimit?'daily_limit_disabled':!providerReady(vlm)?'visual_model_not_configured':'ready';
  return {ready:state==='ready',state,model:vlm.model,daily_limit:c.dailyLimit};
}
export async function submit(input:OmniAnalysisInput) {
  const c=await activeScope(),refId=requestRef(c.workspaceId,c.userId,input.request_id),hash=payloadHash(input);
  return prisma.$transaction(async tx=>{
    // Serializes idempotency and daily admission across all web processes.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`omni-analysis:${c.workspaceId}`}))`;
    await activeScope(tx);
    const existing=await tx.asyncTask.findFirst({where:{workspaceId:c.workspaceId,kind:OMNI_KIND,refId}});
    if(existing){const meta=existing.inputJson as {payload_hash?:string;user_id?:string}|null;if(meta?.payload_hash!==hash||meta?.user_id!==c.userId)throw new OmniError(409,'request_id_conflict');return {created:false,job:jobView(existing)};}
    if(!c.dailyLimit)throw new OmniError(503,'daily_limit_disabled');
    // Local DB/settings only: no model or network work in the HTTP handler.
    if(!providerReady((await getEffectiveAiSettings()).vlm))throw new OmniError(503,'visual_model_not_configured');
    const start=new Date();start.setUTCHours(0,0,0,0);
    const used=await tx.asyncTask.count({where:{workspaceId:c.workspaceId,kind:OMNI_KIND,createdAt:{gte:start}}});
    const pending=await tx.asyncTask.count({where:{workspaceId:c.workspaceId,kind:OMNI_KIND,status:{in:['PENDING','RUNNING']}}});
    if(used>=c.dailyLimit)throw new OmniError(429,'daily_limit_reached');
    if(pending>=20)throw new OmniError(429,'queue_full');
    const task=await tx.asyncTask.create({data:{workspaceId:c.workspaceId,kind:OMNI_KIND,refId,status:'PENDING',
      expiresAt:new Date(Date.now()+OMNI_TTL_MS),inputJson:{payload_hash:hash,user_id:c.userId,request:input}}});
    return {created:true,job:jobView(task)};
  },{maxWait:1000,timeout:5000});
}
export async function getJob(id:string) {
  const c=await activeScope();
  const where={id,workspaceId:c.workspaceId,kind:OMNI_KIND};
  let task=await prisma.asyncTask.findFirst({where});
  if(!task||(task.inputJson as {user_id?:string}|null)?.user_id!==c.userId)throw new OmniError(404,'job_not_found');
  // Polling remains bounded even when the worker is stopped or unavailable.
  if(['PENDING','RUNNING'].includes(task.status)&&task.expiresAt&&task.expiresAt<=new Date()) {
    const meta=task.inputJson as {payload_hash?:string;user_id?:string};
    const closed=await prisma.asyncTask.updateMany({where:{...where,status:{in:['PENDING','RUNNING']},expiresAt:{lte:new Date()}},data:{status:'FAILED',error:'analysis_expired_no_retry',inputJson:{payload_hash:meta.payload_hash || '',user_id:meta.user_id || ''}}});
    if(closed.count===1)return {id,status:'failed' as const,reason:'analysis_expired_no_retry'};
    task=await prisma.asyncTask.findFirst({where});
    if(!task)throw new OmniError(404,'job_not_found');
  }
  return jobView(task);
}

/** Read-only receipt recovery after a lost POST response. Never creates or recharges a job. */
export async function getJobByRequest(requestId:string) {
  if(!OmniAnalysisInput.shape.request_id.safeParse(requestId).success)throw new OmniError(404,'job_not_found');
  const c=await activeScope();
  const task=await prisma.asyncTask.findFirst({where:{workspaceId:c.workspaceId,kind:OMNI_KIND,refId:requestRef(c.workspaceId,c.userId,requestId)},select:{id:true,inputJson:true}});
  if(!task||(task.inputJson as {user_id?:string}|null)?.user_id!==c.userId)throw new OmniError(404,'job_not_found');
  return getJob(task.id);
}

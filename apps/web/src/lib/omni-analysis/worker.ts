import { prisma } from '@brandai/db';
import { OmniAnalysisInput, OmniAnalysisResult } from '@brandai/contracts';
import { getOmniAnalysisProvider } from './configuration';
import { activeScope } from './service';
import { OMNI_KIND, serviceConfig, providerReady } from './policy';
import { analyzeImage } from './provider';
import { AnalysisFailure, safeAnalysisFailure } from './failure';
import { retainedOmniAnalysisMetadata } from './workflow-evidence';

export async function processAnalysis(id:string) {
  const c=serviceConfig(),where={id,workspaceId:c.workspaceId,kind:OMNI_KIND};
  const task=await prisma.asyncTask.findFirst({where});
  if(!task||task.status!=='PENDING'||!task.expiresAt||task.expiresAt<=new Date())return;
  const claim=await prisma.asyncTask.updateMany({where:{...where,status:'PENDING',expiresAt:{gt:new Date()}},data:{status:'RUNNING',progress:10}});
  if(claim.count!==1)return; // Replayed/restarted work never repeats a paid call.
  const meta=task.inputJson as {payload_hash?:string;user_id?:string;request?:unknown}|null;
  const stripped=retainedOmniAnalysisMetadata(task.inputJson);
  const controller=new AbortController();
  const deadline=Math.min(90_000,task.expiresAt.getTime()-Date.now());
  const timer=setTimeout(()=>controller.abort(),Math.max(1,deadline));
  try {
    await activeScope();
    if(c.dailyLimit===0||meta?.user_id!==c.userId)throw new Error('scope_unavailable');
    const input=OmniAnalysisInput.parse(meta?.request);
    const provider=await getOmniAnalysisProvider();
    if(!providerReady(provider))throw new AnalysisFailure('visual_model_not_configured');
    if(controller.signal.aborted)throw new Error('deadline');
    const result=OmniAnalysisResult.parse(await analyzeImage(input,provider,controller.signal));
    await activeScope();
    if(controller.signal.aborted||serviceConfig().dailyLimit===0)throw new Error('deadline');
    await prisma.asyncTask.updateMany({where:{...where,status:'RUNNING',expiresAt:{gt:new Date()}},data:{status:'SUCCEEDED',progress:100,error:null,resultJson:result,inputJson:stripped}});
  } catch(error) {
    // Never persist provider exception text: it can contain headers, keys or image bytes.
    await prisma.asyncTask.updateMany({where:{...where,status:'RUNNING'},data:{status:'FAILED',error:safeAnalysisFailure(error,controller.signal.aborted),inputJson:stripped}});
  } finally {clearTimeout(timer);}
}

export async function sweepAnalysis() {
  const expired=await prisma.asyncTask.findMany({where:{kind:OMNI_KIND,status:{in:['PENDING','RUNNING']},expiresAt:{lte:new Date()}},take:100,select:{id:true,workspaceId:true,inputJson:true}});
  for(const task of expired) {
    await prisma.asyncTask.updateMany({where:{id:task.id,workspaceId:task.workspaceId,kind:OMNI_KIND,status:{in:['PENDING','RUNNING']},expiresAt:{lte:new Date()}},data:{status:'FAILED',error:'analysis_expired_no_retry',inputJson:retainedOmniAnalysisMetadata(task.inputJson)}});
  }
}

/** Durable outbox polling survives web/Redis restarts. One paid job at a time per worker. */
export function createOmniAnalysisWorker() {
  let stopped=false,flight:Promise<void>|null=null;
  const tick=()=>{
    if(stopped||flight)return;
    flight=(async()=>{
      await sweepAnalysis();
      const c=serviceConfig();if(!c.workspaceId||!c.userId||c.dailyLimit===0)return;
      const task=await prisma.asyncTask.findFirst({where:{workspaceId:c.workspaceId,kind:OMNI_KIND,status:'PENDING',expiresAt:{gt:new Date()}},orderBy:{createdAt:'asc'},select:{id:true}});
      if(task)await processAnalysis(task.id);
    })().catch(()=>{console.error('[omni-analysis] worker unavailable; pending work retained');}).finally(()=>{flight=null;});
  };
  const timer=setInterval(tick,2000);timer.unref();tick();
  return {async close(){stopped=true;clearInterval(timer);await flight;}};
}

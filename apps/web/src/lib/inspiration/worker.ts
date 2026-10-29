import { prisma } from '@brandai/db';
import { InspirationSelectedImage } from '@brandai/contracts';
import { inspirationEnabled, syncConfigured } from './config';
import { syncReplica, syncWithdrawals, lockWorkspace } from './replica';
import { listCases } from './service';
import { answerEvidence } from './provider';
import { loadSelectedImages } from './selected-images';
import { requireActiveEditor, requireCurrentEvidence } from './access';
import { retrieveInspirationCases } from './retrieval';
import { inspirationFailureDiagnostic } from './failure';

const terminalError='灵感任务未完成，请检查接入配置或稍后重试。';
const safeMessages=new Set(['案例已撤回或更新。','历史引用已撤回或更新，请重新选择案例。','历史对话中没有这个序号的案例，请重新选择。','引用内容已更新，请重新提问。','灵感问答模型未配置。','请先在 Nova 后台配置支持 OpenAI 协议的问答模型。','模型地址需为受信任 HTTPS 接口。','模型回答被截断，请缩小问题范围。','模型引用了未检索到的证据，回答未保存。','引用上下文过大，请减少选定案例。','所选案例未授权外部模型分析，可继续本地浏览。']);
export async function runInspirationChat(id:string,stopSignal?:AbortSignal) {
  const startedAt=Date.now();
  const row=await prisma.inspirationChat.findUnique({where:{id}});if(!row || row.status!=='PENDING')return;
  if(!(await prisma.inspirationChat.updateMany({where:{id,status:'PENDING',expiresAt:{gt:new Date()}},data:{status:'RUNNING'}})).count)return;
  await prisma.asyncTask.updateMany({where:{id,kind:'INSPIRATION_CHAT',status:'PENDING'},data:{status:'RUNNING',progress:10}});
  const cancelled=new AbortController(),deadline=AbortSignal.timeout(Math.max(1,Math.min(240000,row.expiresAt.getTime()-Date.now()))),signal=AbortSignal.any([cancelled.signal,deadline,...(stopSignal?[stopSignal]:[])]);
  let checking=false;const cancellationTimer=setInterval(()=>{if(checking)return;checking=true;void prisma.inspirationChat.findUnique({where:{id},select:{status:true}}).then(current=>{if(current?.status!=='RUNNING')cancelled.abort();}).catch(()=>cancelled.abort()).finally(()=>{checking=false;});},2000);cancellationTimer.unref();
  try {
    await requireActiveEditor(row.workspaceId,row.userId);
    const selectedImages=InspirationSelectedImage.array().max(2).parse(row.selectedImages);
    const all=await listCases(row.workspaceId);const ids=[...new Set([...(row.caseIds as string[]),...selectedImages.map(i=>i.caseId)])];
    if(ids.some(id=>all.cases.some(c=>c.caseId===id&&!c.analysisAllowed)))throw new Error('所选案例未授权外部模型分析，可继续本地浏览。');
    all.cases=all.cases.filter(c=>c.analysisAllowed);
    const previous=await prisma.inspirationChat.findMany({where:{workspaceId:row.workspaceId,userId:row.userId,conversationId:row.conversationId,status:'SUCCEEDED',createdAt:{lt:row.createdAt}},orderBy:{createdAt:'desc'},take:6});
    let selected=ids.length ? all.cases.filter(c=>ids.includes(c.caseId)) : [];
    if(ids.length && selected.length!==ids.length) throw new Error('案例已撤回或更新。');
    if(!selected.length && /前两个|第二个|第一个|第三个/u.test(row.question) && !previous[0])throw new Error('历史对话中没有这个序号的案例，请重新选择。');
    // Ordinal references use saved case order, never a newly reordered search result.
    if(!selected.length && /前两个|第二个|第一个|第三个|这几个|比较|继续/u.test(row.question) && previous[0]) {
      const refs=previous[0].citations as Array<{caseId:string;revision:number}>;
      const valid=refs.map(ref=>all.cases.find(c=>c.caseId===ref.caseId && c.revision===ref.revision));
      if(valid.some(c=>!c)) throw new Error('历史引用已撤回或更新，请重新选择案例。');
      selected=valid.filter((c):c is NonNullable<typeof c>=>!!c);
      if(/前两个/u.test(row.question))selected=selected.slice(0,2);
      else if(/第二个/u.test(row.question))selected=selected.slice(1,2);
      else if(/第一个/u.test(row.question))selected=selected.slice(0,1);
      else if(/第三个/u.test(row.question))selected=selected.slice(2,3);
      if(!selected.length)throw new Error('历史对话中没有这个序号的案例，请重新选择。');
    }
    if(!selected.length)selected=await retrieveInspirationCases(row.workspaceId,row.userId,row.question,signal);
    if(!selected.length) {
      await prisma.inspirationChat.updateMany({where:{id,status:'RUNNING',expiresAt:{gt:new Date()}},data:{status:'SUCCEEDED',answer:'当前本地知识库中没有足够相关的已审核案例。请调整关键词，或等待新的知识包同步。',citations:[]}});return;
    }
    await requireActiveEditor(row.workspaceId,row.userId);
    const beforeModel=await listCases(row.workspaceId);if(selected.some(c=>!beforeModel.cases.some(n=>n.caseId===c.caseId&&n.revision===c.revision&&n.analysisAllowed)))throw new Error('引用内容已更新，请重新提问。');
    const images=await loadSelectedImages(row.workspaceId,selectedImages,signal);
    // Image conversion/cache work may take time: perform the final gate afterwards.
    await requireCurrentEvidence(row.workspaceId,row.userId,selected);
    const historyCurrent=await listCases(row.workspaceId);
    // Old answers may repeat the historic fabricated taxonomy defaults. Keep
    // stored/UI history and ordinal references, but do not reuse those answers
    // as model context even when their signed case revision is unchanged.
    const history=previous.reverse().filter(p=>(p.citations as Array<{caseId:string;revision:number}>).every(ref=>historyCurrent.cases.some(c=>c.caseId===ref.caseId && c.revision===ref.revision&&c.analysisAllowed&&c.taxonomyStatus!=='legacy'))).map(p=>({question:p.question,answer:p.answer}));
    const result=await answerEvidence(row.question,selected,history,signal,images);signal.throwIfAborted();
    await requireActiveEditor(row.workspaceId,row.userId);
    // A revocation may arrive during inference: never persist an answer against stale evidence.
    const now=await listCases(row.workspaceId);if(result.citations.some(c=>!now.cases.some(n=>n.caseId===c.caseId&&n.revision===c.revision)))throw new Error('引用内容已更新，请重新提问。');
    await prisma.inspirationChat.updateMany({where:{id,status:'RUNNING',expiresAt:{gt:new Date()}},data:{status:'SUCCEEDED',answer:result.answer,citations:result.citations.map(c=>({caseId:c.caseId,revision:c.revision})),model:result.model,inputTokens:result.inputTokens,outputTokens:result.outputTokens}});
  } catch(error) {
    console.warn('[inspiration-chat] failed',inspirationFailureDiagnostic(error,signal.aborted));
    await prisma.inspirationChat.updateMany({where:{id,status:'RUNNING'},data:{status:'FAILED',error:error instanceof Error && safeMessages.has(error.message)?error.message:terminalError}});
  }
  finally {clearInterval(cancellationTimer);await prisma.inspirationChat.updateMany({where:{id},data:{latencyMs:Date.now()-startedAt}});const current=await prisma.inspirationChat.findUnique({where:{id}});if(current)await prisma.asyncTask.updateMany({where:{id,kind:'INSPIRATION_CHAT',status:{in:['PENDING','RUNNING']}},data:{status:current.status,progress:current.status==='SUCCEEDED'?100:10,error:current.error}});}
}
export function createInspirationWorker() {
  let stopped=false,busy=false,withdrawalBusy=false;const abort=new AbortController(),attempted=new Map<string,number>();
  async function tick() {
    if(stopped || busy || !inspirationEnabled())return;busy=true;
    try {
      await prisma.inspirationChat.updateMany({where:{status:{in:['PENDING','RUNNING']},expiresAt:{lte:new Date()}},data:{status:'FAILED',error:'任务已超时，请重试。'}});
      await prisma.asyncTask.updateMany({where:{kind:'INSPIRATION_CHAT',status:{in:['PENDING','RUNNING']},expiresAt:{lte:new Date()}},data:{status:'FAILED',error:'任务已超时，请重试。'}});
      const pending=await prisma.inspirationChat.findFirst({where:{status:'PENDING',expiresAt:{gt:new Date()}},orderBy:{createdAt:'asc'}});if(pending)await runInspirationChat(pending.id,abort.signal);
      const task=await prisma.asyncTask.findFirst({where:{kind:'INSPIRATION_SYNC',status:'PENDING',expiresAt:{gt:new Date()}},orderBy:{createdAt:'asc'}});
      if(task && (await prisma.asyncTask.updateMany({where:{id:task.id,status:'PENDING',expiresAt:{gt:new Date()}},data:{status:'RUNNING',progress:10}})).count) {
        try {await syncReplica(task.workspaceId,AbortSignal.any([abort.signal,AbortSignal.timeout(Math.max(1,Math.min(240000,task.expiresAt!.getTime()-Date.now())))]));await prisma.asyncTask.updateMany({where:{id:task.id,status:'RUNNING',expiresAt:{gt:new Date()}},data:{status:'SUCCEEDED',progress:100}});}
        catch {await prisma.asyncTask.updateMany({where:{id:task.id,status:'RUNNING'},data:{status:'FAILED',error:terminalError}});}
      }
      await prisma.asyncTask.updateMany({where:{kind:'INSPIRATION_SYNC',status:{in:['PENDING','RUNNING']},expiresAt:{lte:new Date()}},data:{status:'FAILED',error:'同步任务已超时，请重试。'}});
      if(syncConfigured()) {
        const due=await prisma.inspirationState.findMany({where:{OR:[{lastSyncAt:null},{lastSyncAt:{lt:new Date(Date.now()-5*60000)}}]},take:20});
        for(const state of due) {if(Date.now()-(attempted.get(state.workspaceId)??0)<5*60000)continue;attempted.set(state.workspaceId,Date.now());
          await prisma.$transaction(async tx=>{await lockWorkspace(tx,state.workspaceId);const pending=await tx.asyncTask.count({where:{workspaceId:state.workspaceId,kind:'INSPIRATION_SYNC',status:{in:['PENDING','RUNNING']}}});if(!pending)await tx.asyncTask.create({data:{workspaceId:state.workspaceId,kind:'INSPIRATION_SYNC',expiresAt:new Date(Date.now()+6*60000)}});});}
      }
    } finally {busy=false;}
  }
  const timer=setInterval(()=>{void tick().catch(()=>console.error('[inspiration] background dispatcher failed'));},5000);timer.unref();
  async function withdrawals(){if(stopped||withdrawalBusy||!inspirationEnabled()||!syncConfigured())return;withdrawalBusy=true;
    try{const states=await prisma.inspirationState.findMany({take:200,select:{workspaceId:true}});for(const state of states){if(stopped)break;try{await syncWithdrawals(state.workspaceId,AbortSignal.any([abort.signal,AbortSignal.timeout(15000)]));}catch{console.warn('[inspiration] withdrawal check failed');}}}finally{withdrawalBusy=false;}}
  const withdrawalTimer=setInterval(()=>{void withdrawals().catch(()=>console.error('[inspiration] withdrawal check failed'));},60000);withdrawalTimer.unref();void withdrawals().catch(()=>undefined);
  void tick().catch(()=>undefined);
  return {close:async()=>{stopped=true;abort.abort();clearInterval(timer);clearInterval(withdrawalTimer);}};
}

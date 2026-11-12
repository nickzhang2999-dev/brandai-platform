import {PublisherReadError} from './publisher-fetch';
import { randomUUID } from 'node:crypto';
import { Prisma,prisma } from '@brandai/db';
import { InspirationSelectedImage } from '@brandai/contracts';
import { contentSyncMode, inspirationEnabled, syncConfigured } from './config';
import { syncReplica, syncWithdrawals, lockWorkspace } from './replica';
import { currentCases } from './service';
import { answerEvidence } from './provider';
import { loadSelectedImages } from './selected-images';
import { requireActiveEditor, requireCurrentEvidence, requireLibraryReceiver } from './access';
import { retrieveInspirationCases } from './retrieval';
import { inspirationFailureDiagnostic } from './failure';
import { DailyReceiptLimit } from './daily-receipts';
import { DAILY_IMAGE_LIMIT_CODE,dailyImageLimitMessage } from './sync-status';
import {continueSnapshotInput,InspirationSyncClaimLost,type SnapshotTaskInput} from './snapshot-tasks';

const terminalError='灵感任务未完成，请检查接入配置或稍后重试。';
const safeMessages=new Set(['案例已撤回或更新。','历史引用已撤回或更新，请重新选择案例。','历史对话中没有这个序号的案例，请重新选择。','引用内容已更新，请重新提问。','灵感问答模型未配置。','请先在 Nova 后台配置支持 OpenAI 协议的问答模型。','模型地址需为受信任 HTTPS 接口。','模型回答被截断，请缩小问题范围。','模型引用了未检索到的证据，回答未保存。','引用上下文过大，请减少选定案例。','所选案例未授权外部模型分析，可继续本地浏览。']);
export async function runInspirationChat(id:string,stopSignal?:AbortSignal) {
  const startedAt=Date.now();
  const row=await prisma.inspirationChat.findUnique({where:{id}});if(!row || row.status!=='PENDING')return;
  if(!(await prisma.inspirationChat.updateMany({where:{id,status:'PENDING',expiresAt:{gt:new Date()}},data:{status:'RUNNING'}})).count)return;
  await prisma.inspirationLibraryTask.updateMany({where:{id,kind:'INSPIRATION_CHAT',status:'PENDING'},data:{status:'RUNNING',progress:10}});
  const cancelled=new AbortController(),deadline=AbortSignal.timeout(Math.max(1,Math.min(240000,row.expiresAt.getTime()-Date.now()))),signal=AbortSignal.any([cancelled.signal,deadline,...(stopSignal?[stopSignal]:[])]);
  let checking=false;const cancellationTimer=setInterval(()=>{if(checking)return;checking=true;void prisma.inspirationChat.findUnique({where:{id},select:{status:true}}).then(current=>{if(current?.status!=='RUNNING')cancelled.abort();}).catch(()=>cancelled.abort()).finally(()=>{checking=false;});},2000);cancellationTimer.unref();
  try {
    await requireActiveEditor(row.workspaceId,row.userId);
    const selectedImages=InspirationSelectedImage.array().max(2).parse(row.selectedImages);
    const ids=[...new Set([...(row.caseIds as string[]),...selectedImages.map(i=>i.caseId)])];
    const previous=await prisma.inspirationChat.findMany({where:{workspaceId:row.workspaceId,userId:row.userId,conversationId:row.conversationId,libraryId:row.libraryId,status:'SUCCEEDED',createdAt:{lt:row.createdAt}},orderBy:{createdAt:'desc'},take:6});
    const historyIds=previous.flatMap(p=>(p.citations as Array<{caseId:string}>).map(ref=>ref.caseId));
    const all=await currentCases(row.workspaceId,row.libraryId,[...new Set([...ids,...historyIds])]);
    if(ids.some(id=>all.cases.some(c=>c.caseId===id&&!c.analysisAllowed)))throw new Error('所选案例未授权外部模型分析，可继续本地浏览。');
    all.cases=all.cases.filter(c=>c.analysisAllowed);
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
    if(!selected.length)selected=await retrieveInspirationCases(row.workspaceId,row.userId,row.question,signal,row.libraryId);
    if(!selected.length) {
      await prisma.inspirationChat.updateMany({where:{id,status:'RUNNING',expiresAt:{gt:new Date()}},data:{status:'SUCCEEDED',answer:'当前本地知识库中没有足够相关的已审核案例。请调整关键词，或等待新的知识包同步。',citations:[]}});return;
    }
    await requireActiveEditor(row.workspaceId,row.userId);
    const beforeModel=await currentCases(row.workspaceId,row.libraryId,selected.map(c=>c.caseId));if(selected.some(c=>!beforeModel.cases.some(n=>n.caseId===c.caseId&&n.revision===c.revision&&n.analysisAllowed)))throw new Error('引用内容已更新，请重新提问。');
    const images=await loadSelectedImages(row.workspaceId,selectedImages,signal,row.libraryId);
    // Image conversion/cache work may take time: perform the final gate afterwards.
    await requireCurrentEvidence(row.workspaceId,row.userId,selected,row.libraryId);
    const historyCurrent=await currentCases(row.workspaceId,row.libraryId,historyIds);
    // Old answers may repeat the historic fabricated taxonomy defaults. Keep
    // stored/UI history and ordinal references, but do not reuse those answers
    // as model context even when their signed case revision is unchanged.
    const history=previous.reverse().filter(p=>(p.citations as Array<{caseId:string;revision:number}>).every(ref=>historyCurrent.cases.some(c=>c.caseId===ref.caseId && c.revision===ref.revision&&c.analysisAllowed&&c.taxonomyStatus!=='legacy'))).map(p=>({question:p.question,answer:p.answer}));
    const result=await answerEvidence(row.question,selected,history,signal,images);signal.throwIfAborted();
    await requireActiveEditor(row.workspaceId,row.userId);
    // A revocation may arrive during inference: never persist an answer against stale evidence.
    const now=await currentCases(row.workspaceId,row.libraryId,result.citations.map(c=>c.caseId));if(result.citations.some(c=>!now.cases.some(n=>n.caseId===c.caseId&&n.revision===c.revision)))throw new Error('引用内容已更新，请重新提问。');
    await prisma.inspirationChat.updateMany({where:{id,status:'RUNNING',expiresAt:{gt:new Date()}},data:{status:'SUCCEEDED',answer:result.answer,citations:result.citations.map(c=>({caseId:c.caseId,revision:c.revision})),model:result.model,inputTokens:result.inputTokens,outputTokens:result.outputTokens}});
  } catch(error) {
    console.warn('[inspiration-chat] failed',inspirationFailureDiagnostic(error,signal.aborted));
    await prisma.inspirationChat.updateMany({where:{id,status:'RUNNING'},data:{status:'FAILED',error:error instanceof Error && safeMessages.has(error.message)?error.message:terminalError}});
  }
  finally {clearInterval(cancellationTimer);await prisma.inspirationChat.updateMany({where:{id},data:{latencyMs:Date.now()-startedAt}});const current=await prisma.inspirationChat.findUnique({where:{id}});if(current)await prisma.inspirationLibraryTask.updateMany({where:{id,kind:'INSPIRATION_CHAT',status:{in:['PENDING','RUNNING']}},data:{status:current.status,progress:current.status==='SUCCEEDED'?100:10,error:current.error}});}
}
export function createInspirationWorker() {
  let stopped=false,busy=false,withdrawalBusy=false;const abort=new AbortController(),attempted=new Map<string,number>();
  async function tick() {
    if(stopped || busy || !inspirationEnabled())return;busy=true;
    try {
      await prisma.inspirationChat.updateMany({where:{status:{in:['PENDING','RUNNING']},expiresAt:{lte:new Date()}},data:{status:'FAILED',error:'任务已超时，请重试。'}});
      await prisma.inspirationLibraryTask.updateMany({where:{kind:'INSPIRATION_CHAT',status:{in:['PENDING','RUNNING']},expiresAt:{lte:new Date()}},data:{status:'FAILED',error:'任务已超时，请重试。'}});
      const pending=await prisma.inspirationChat.findFirst({where:{status:'PENDING',expiresAt:{gt:new Date()}},orderBy:{createdAt:'asc'}});if(pending)await runInspirationChat(pending.id,abort.signal);
      if(process.env.INSPIRATION_SNAPSHOT_V3_ENABLED==='true') {
        // A crashed bounded chunk may resume the same fixed-root intent. Legacy
        // jobs and expired 24h intents retain their existing timeout behavior.
        const abandoned=await prisma.inspirationLibraryTask.findMany({where:{kind:'INSPIRATION_SYNC',status:'RUNNING',expiresAt:{lte:new Date()}},take:20});
        for(const item of abandoned) {
          const input=item.inputJson as SnapshotTaskInput|null;
          if(!input?.snapshotSessionId)continue;
          try {const resumed=continueSnapshotInput(input,input.snapshotSessionId);
            await prisma.inspirationLibraryTask.updateMany({where:{id:item.id,status:'RUNNING',expiresAt:item.expiresAt},data:{status:'PENDING',expiresAt:new Date(Date.now()+6*60000),inputJson:resumed,error:null}});
          }catch{/* The normal bounded timeout below will close this intent. */}
        }
      }
      const task=await prisma.inspirationLibraryTask.findFirst({where:{kind:'INSPIRATION_SYNC',inspirationLibraryId:{not:null},status:'PENDING',expiresAt:{gt:new Date()},
        ...(contentSyncMode()==='manual'?{inputJson:{path:['trigger'],equals:'manual'}}:{})},orderBy:{createdAt:'asc'}});
      const claimId=randomUUID();
      const claimedInput:SnapshotTaskInput={...(task?.inputJson&&typeof task.inputJson==='object'&&!Array.isArray(task.inputJson)?task.inputJson as SnapshotTaskInput:{}),syncClaimId:claimId};
      if(task && (await prisma.inspirationLibraryTask.updateMany({where:{id:task.id,status:'PENDING',updatedAt:task.updatedAt,expiresAt:task.expiresAt,
        inputJson:{equals:task.inputJson===null?Prisma.AnyNull:task.inputJson as Prisma.InputJsonValue},AND:[{expiresAt:{gt:new Date()}}]},data:{status:'RUNNING',progress:10,inputJson:claimedInput}})).count) {
        // UUID fencing is independent of millisecond timestamp resolution. A
        // recovered task may keep its ID, but can never inherit this execution.
        const claimWhere=()=>({id:task.id,status:'RUNNING' as const,expiresAt:task.expiresAt,inputJson:{path:['syncClaimId'],equals:claimId},AND:[{expiresAt:{gt:new Date()}}]});
        const assertClaim=async()=>{
          const current=await prisma.inspirationLibraryTask.findUnique({where:{id:task.id},select:{status:true,expiresAt:true,inputJson:true}});
          if(current?.status!=='RUNNING'||!current.expiresAt||current.expiresAt.getTime()<=Date.now()||current.expiresAt.getTime()!==task.expiresAt?.getTime()
            ||(current.inputJson as SnapshotTaskInput|null)?.syncClaimId!==claimId)throw new InspirationSyncClaimLost();
        };
        try {
          const library=task.inspirationLibraryId?await prisma.inspirationLibrary.findUnique({where:{id:task.inspirationLibraryId}}):null;
          if(!library)throw new Error('Publication recipient mismatch');
          let input:SnapshotTaskInput=claimedInput;
          const recheck=async()=>{
            await assertClaim();
            if(!inspirationEnabled()||!syncConfigured(library.kind))throw new Error('Library receiver access changed');
            if(input?.trigger==='manual') {
              if(!input.userId)throw new Error('Library receiver access changed');
              await requireLibraryReceiver(library,input.workspaceId||task.workspaceId,input.userId);
            }else if(contentSyncMode()!=='automatic')throw new Error('Library receiver access changed');
            await assertClaim();
          };
          await recheck();
          const outcome=await syncReplica(library,AbortSignal.any([abort.signal,AbortSignal.timeout(Math.max(1,Math.min(240000,task.expiresAt!.getTime()-Date.now())))]),recheck,{sessionId:input?.snapshotSessionId,onSession:async sessionId=>{
            input=continueSnapshotInput(input??{},sessionId);
            const saved=await prisma.inspirationLibraryTask.updateMany({where:claimWhere(),data:{inputJson:input}});
            if(!saved.count)throw new InspirationSyncClaimLost();
          }});
          if(outcome&&!outcome.complete) {
            const waiting=outcome.status.startsWith('WAITING_');
            const error=outcome.status==='WAITING_CAPACITY'?'灵感库存储容量不足，已保存接收进度，已有内容保留。':outcome.status==='WAITING_DAILY_QUOTA'?dailyImageLimitMessage(contentSyncMode()):null;
            await prisma.inspirationLibraryTask.updateMany({where:claimWhere(),data:{status:waiting?'FAILED':'PENDING',expiresAt:new Date(Date.now()+6*60000),error,resultJson:{libraryId:library.id,snapshotSessionId:outcome.sessionId,phase:outcome.status,bytesThisTick:outcome.bytes,objectsThisTick:outcome.objects,...(waiting?{failureCode:outcome.status==='WAITING_DAILY_QUOTA'?DAILY_IMAGE_LIMIT_CODE:'SNAPSHOT_CAPACITY'}:{})}}});
          }else await prisma.inspirationLibraryTask.updateMany({where:claimWhere(),data:{status:'SUCCEEDED',progress:100,error:null,resultJson:{libraryId:library.id}}});
        } catch(error) {
          if(error instanceof InspirationSyncClaimLost)return;
          const scope=error instanceof Error&&error.message==='Publication recipient mismatch';
          const access=error instanceof Error&&error.message==='Library receiver access changed';
          const timedOut=error instanceof Error&&['AbortError','TimeoutError'].includes(error.name);
          const dailyLimit=error instanceof DailyReceiptLimit;
          const failureCode=dailyLimit?DAILY_IMAGE_LIMIT_CODE:scope?'LIBRARY_SCOPE_MISMATCH':access?'RECEIVER_ACCESS_CHANGED':timedOut?'SYNC_TIMEOUT':'SYNC_FAILED';
          const message=dailyLimit?dailyImageLimitMessage(contentSyncMode()):scope?'发布包与当前灵感库的接收范围不一致，请联系管理员检查库配置。':access?'接收权限已变化，请由当前灵感库管理员重新确认。':timedOut?'灵感接收超时，已有内容保留。':terminalError;
          const diagnostic=error instanceof PublisherReadError?{phase:error.phase,reason:error.reason,attempts:error.attempts,...(error.status?{httpStatus:error.status}:{})}:{};
          console.warn('[inspiration-sync] failed',{failureCode,...diagnostic});
          await prisma.inspirationLibraryTask.updateMany({where:claimWhere(),data:{status:'FAILED',error:message,resultJson:{failureCode,...diagnostic}}});
        }
      }
      await prisma.inspirationLibraryTask.updateMany({where:{kind:'INSPIRATION_SYNC',status:{in:['PENDING','RUNNING']},expiresAt:{lte:new Date()}},data:{status:'FAILED',error:'同步任务已超时，请重试。'}});
      if(contentSyncMode()==='automatic') {
        const due=await prisma.inspirationState.findMany({where:{OR:[{lastSyncAt:null},{lastSyncAt:{lt:new Date(Date.now()-5*60000)}}]},include:{library:true},take:20});
        for(const state of due) {
          if(!syncConfigured(state.library.kind)||Date.now()-(attempted.get(state.libraryId)??0)<5*60000)continue;attempted.set(state.libraryId,Date.now());
          const workspaceId=state.library.legacyWorkspaceId||(await prisma.brandWorkspace.findFirst({where:{ownerId:state.library.ownerId},select:{id:true}}))?.id;
          if(!workspaceId)continue;
          await prisma.$transaction(async tx=>{await lockWorkspace(tx,state.libraryId);const pending=await tx.inspirationLibraryTask.count({where:{inspirationLibraryId:state.libraryId,kind:'INSPIRATION_SYNC',status:{in:['PENDING','RUNNING']}}});if(!pending)await tx.inspirationLibraryTask.create({data:{workspaceId,inspirationLibraryId:state.libraryId,kind:'INSPIRATION_SYNC',expiresAt:new Date(Date.now()+6*60000),inputJson:{trigger:'automatic'}}});});
        }
      }
    } finally {busy=false;}
  }
  const timer=setInterval(()=>{void tick().catch(()=>console.error('[inspiration] background dispatcher failed'));},5000);timer.unref();
  async function withdrawals(){if(stopped||withdrawalBusy||!inspirationEnabled())return;withdrawalBusy=true;
    try{const states=await prisma.inspirationState.findMany({take:200,include:{library:true}});for(const state of states){if(stopped)break;if(!syncConfigured(state.library.kind))continue;try{await syncWithdrawals(state.library,AbortSignal.any([abort.signal,AbortSignal.timeout(15000)]));}catch{console.warn('[inspiration] withdrawal check failed');}}}finally{withdrawalBusy=false;}}
  const withdrawalTimer=setInterval(()=>{void withdrawals().catch(()=>console.error('[inspiration] withdrawal check failed'));},60000);withdrawalTimer.unref();void withdrawals().catch(()=>undefined);
  void tick().catch(()=>undefined);
  return {close:async()=>{stopped=true;abort.abort();clearInterval(timer);clearInterval(withdrawalTimer);}};
}

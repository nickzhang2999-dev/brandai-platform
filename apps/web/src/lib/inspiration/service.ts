import { Prisma, prisma } from '@brandai/db';
import type { InspirationCaseCard, InspirationChatState } from '@brandai/contracts';
import { ApiException } from '../api';
import { activeRecords } from './replica';
import { inspirationEnabled, syncConfigured } from './config';
import { PublishedCase } from './protocol';

export function requireEnabled() { if(!inspirationEnabled()) throw new ApiException(503,'灵感库尚未启用，请联系管理员完成接入。'); }
export function card(workspaceId:string, value:unknown): InspirationCaseCard {
  const c=PublishedCase.parse(value);
  const analysisAllowed=[c,...c.sources,...c.images].every(entity=>(entity.permissions as {analysis?:string}|undefined)?.analysis==='allowed');
  return {caseId:c.case_id,revision:c.revision,title:c.title,summary:c.summary_zh,brandOrTeam:c.brand_or_team,analysisAllowed,tags:c.tags,
    images:c.images.map(i=>({imageId:i.image_id,url:`/api/workspaces/${encodeURIComponent(workspaceId)}/inspiration/cases/${encodeURIComponent(c.case_id)}/images/${encodeURIComponent(i.image_id)}?revision=${c.revision}`})),
    sources:c.sources.map(s=>({sourceId:s.source_id,url:s.url})),claims:c.claims.map(x=>({claimId:x.claim_id,kind:x.kind,text:x.text,sourceIds:x.source_ids,imageIds:x.image_ids}))};
}
export function keywordScore(c:InspirationCaseCard, query:string) {
  const text=[c.title,c.summary,c.brandOrTeam,...Object.values(c.tags).flat(),...c.claims.map(c=>c.text)].join(' ').toLocaleLowerCase();
  const words=query.toLocaleLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]+/gu) ?? [];
  const terms=words.flatMap(w=>/[\u3400-\u9fff]/u.test(w) && w.length>2 ? [w,...Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2))] : [w]);
  return [...new Set(terms)].reduce((n,t)=>n+(text.includes(t)?t.length:0),0);
}
export async function listCases(workspaceId:string, filters:{q?:string;industry?:string;medium?:string}={}) {
  const {state,release,records}=await activeRecords(workspaceId);
  const all=records.map(r=>card(workspaceId,r.body));
  const cases=all.filter(c=>(!filters.industry || c.tags.industry?.includes(filters.industry)) && (!filters.medium || c.tags.medium?.includes(filters.medium)))
    .map(c=>({c,score:keywordScore(c,filters.q ?? '')})).filter(r=>!filters.q || r.score>0).sort((a,b)=>b.score-a.score || a.c.caseId.localeCompare(b.c.caseId)).slice(0,200).map(r=>r.c);
  return {enabled:inspirationEnabled(),syncConfigured:syncConfigured(),activeRelease:release?{id:release.releaseId,sequence:release.sequence,createdAt:release.createdAt.toISOString()}:null,caseCount:all.length,withdrawalSequence:state?.withdrawalSequence ?? 0,lastSyncAt:state?.lastSyncAt?.toISOString() ?? null,error:state?.lastError ?? null,cases,searchMode:'keyword-tags' as const};
}
export async function getCase(workspaceId:string, caseId:string, revision?:number) {
  const {records}=await activeRecords(workspaceId); const row=records.find(r=>r.caseId===caseId && (revision===undefined || r.revision===revision));
  if(!row) throw new ApiException(404,'案例已撤回、版本已更新或不可访问。'); return {row,case:card(workspaceId,row.body)};
}
export async function getChat(workspaceId:string,userId:string,id:string): Promise<InspirationChatState> {
  const row=await prisma.inspirationChat.findFirst({where:{workspaceId,userId,id}}); if(!row) throw new ApiException(404,'对话不存在。');
  if(['PENDING','RUNNING'].includes(row.status) && row.expiresAt<new Date()) {
    await prisma.inspirationChat.updateMany({where:{id,workspaceId,userId,status:{in:['PENDING','RUNNING']}},data:{status:'FAILED',error:'任务已超时，请重试。'}}); row.status='FAILED';row.error='任务已超时，请重试。';
  }
  const {records}=await activeRecords(workspaceId); const refs=(Array.isArray(row.citations)?row.citations:[]) as unknown as Array<{caseId:string;revision:number}>;
  const citations=refs.flatMap(ref=>{const r=records.find(r=>r.caseId===ref.caseId && r.revision===ref.revision);return r?[card(workspaceId,r.body)]:[];});
  const invalid=citations.length!==refs.length;
  return {id:row.id,conversationId:row.conversationId,status:row.status,question:row.question,answer:invalid?'引用内容已撤回或更新，请重新检索后提问。':row.answer,citations,error:row.error,createdAt:row.createdAt.toISOString()};
}
type ChatInput={requestId:string;question:string;conversationId?:string;caseIds?:string[];selectedImages?:Array<{caseId:string;imageId:string;revision:number}>};
function sameInput(row:{question:string;conversationId:string;caseIds:unknown;selectedImages?:unknown},input:ChatInput) {return row.question===input.question && (!input.conversationId || input.conversationId===row.conversationId) && JSON.stringify(row.caseIds)===JSON.stringify(input.caseIds ?? []) && JSON.stringify(row.selectedImages ?? [])===JSON.stringify(input.selectedImages ?? []);}
export async function createChat(workspaceId:string,userId:string,input:ChatInput) {
  if(new Set([...(input.caseIds??[]),...(input.selectedImages??[]).map(i=>i.caseId)]).size>8)throw new ApiException(422,'每轮最多选择 8 个案例。');
  const same=await prisma.inspirationChat.findUnique({where:{workspaceId_userId_requestId:{workspaceId,userId,requestId:input.requestId}}});
  if(same) { if(!sameInput(same,input)) throw new ApiException(409,'请求标识已被其他内容使用。'); return same; }
  const conversationId=input.conversationId ?? crypto.randomUUID();
  if(input.conversationId && !await prisma.inspirationChat.findFirst({where:{workspaceId,userId,conversationId}})) throw new ApiException(404,'对话不存在。');
  for(const id of input.caseIds ?? []) await getCase(workspaceId,id);
  for(const image of input.selectedImages ?? []) {const c=(await getCase(workspaceId,image.caseId,image.revision)).case;if(!c.analysisAllowed || !c.images.some(i=>i.imageId===image.imageId))throw new ApiException(403,'选定图片不可用于外部模型分析。');}
  if(new Set((input.selectedImages ?? []).map(i=>`${i.caseId}:${i.imageId}`)).size!==(input.selectedImages ?? []).length)throw new ApiException(422,'请勿重复选择同一图片。');
  const owner=await prisma.brandWorkspace.findUniqueOrThrow({where:{id:workspaceId},select:{ownerId:true}});
  return prisma.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inspiration-budget:${owner.ownerId}`}))`;
    const existing=await tx.inspirationChat.findUnique({where:{workspaceId_userId_requestId:{workspaceId,userId,requestId:input.requestId}}});
    if(existing) {if(!sameInput(existing,input))throw new ApiException(409,'请求标识已被其他内容使用。');return existing;}
    const tenantSpaces=await tx.brandWorkspace.findMany({where:{ownerId:owner.ownerId},select:{id:true}});
    const today=new Date();today.setUTCHours(0,0,0,0);
    const configuredLimit=Number(process.env.INSPIRATION_DAILY_CHAT_LIMIT??100),dailyLimit=Number.isInteger(configuredLimit)&&configuredLimit>=1&&configuredLimit<=10000?configuredLimit:100;
    if(await tx.inspirationChat.count({where:{workspaceId:{in:tenantSpaces.map(w=>w.id)},createdAt:{gte:today}}})>=dailyLimit) throw new ApiException(429,'今日灵感问答试点额度已用完。');
    if(await tx.inspirationChat.count({where:{workspaceId,userId,conversationId,status:{in:['PENDING','RUNNING']},expiresAt:{gt:new Date()}}})) throw new ApiException(409,'本轮回答尚未完成，请稍后继续。');
    const expiresAt=new Date(Date.now()+6*60000);
    const row=await tx.inspirationChat.create({data:{workspaceId,userId,requestId:input.requestId,conversationId,question:input.question,caseIds:input.caseIds ?? [],selectedImages:input.selectedImages ?? [],expiresAt}});
    await tx.asyncTask.create({data:{id:row.id,workspaceId,kind:'INSPIRATION_CHAT',expiresAt,inputJson:{userId,conversationId}}});return row;
  });
}

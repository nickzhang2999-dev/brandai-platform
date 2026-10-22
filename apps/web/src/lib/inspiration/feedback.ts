import { prisma } from '@brandai/db';
import { InspirationFeedback as FeedbackSchema, InspirationFeedbackInput, InspirationFeedbackUpdate, type InspirationFeedback, type InspirationFeedbackList } from '@brandai/contracts';
import { ApiException } from '../api';
import { requireWorkspaceRole } from '../workspace';
import { activeRecords } from './replica';
import { getCase, requireEnabled } from './service';

const select={id:true,caseId:true,revision:true,kind:true,note:true,status:true,createdAt:true} as const;
type FeedbackRow={id:string;caseId:string;revision:number;kind:string;note:string;status:string;createdAt:Date};
function view(row:FeedbackRow,title:string|null):InspirationFeedback {
  // No publisher body/snapshot is retained in feedback. Revocation is resolved fresh on every read.
  return FeedbackSchema.parse({...row,createdAt:row.createdAt.toISOString(),caseTitle:title,unavailable:title===null});
}
export async function listInspirationFeedback(workspaceId:string,userId:string,scope:'mine'|'review'='mine'):Promise<InspirationFeedbackList> {
  requireEnabled();
  const {role}=await requireWorkspaceRole(workspaceId,userId,scope==='review'?'OWNER':'VIEWER');
  const rows=await prisma.inspirationFeedback.findMany({where:{workspaceId,...(scope==='review'?{status:'OPEN'}:{userId})},select,orderBy:{createdAt:'desc'},take:100});
  const {records}=await activeRecords(workspaceId);
  return {scope,canReview:role==='OWNER',items:rows.map(row=>{
    const current=records.find(r=>r.caseId===row.caseId&&r.revision===row.revision);
    const title=current && typeof current.body==='object' && current.body && !Array.isArray(current.body) && typeof current.body.title==='string' ? current.body.title : null;
    return view(row,title);
  })};
}
export async function submitInspirationFeedback(workspaceId:string,userId:string,raw:unknown):Promise<InspirationFeedback> {
  requireEnabled();await requireWorkspaceRole(workspaceId,userId,'VIEWER');
  const input=InspirationFeedbackInput.parse(raw),current=await getCase(workspaceId,input.caseId,input.revision);
  if(current.case.revision!==input.revision)throw new ApiException(409,'案例版本已更新，请刷新后反馈。');
  const row=await prisma.inspirationFeedback.create({data:{workspaceId,userId,...input,status:'OPEN'},select});
  return view(row,current.case.title);
}

/** Closing is a B-side review decision after manual source correction; it never edits or sends anything to A. */
export async function reviewInspirationFeedback(workspaceId:string,userId:string,id:string,raw:unknown):Promise<{id:string;status:'OPEN'|'RESOLVED'}> {
  requireEnabled();await requireWorkspaceRole(workspaceId,userId,'OWNER');
  const {status}=InspirationFeedbackUpdate.parse(raw);
  const result=await prisma.inspirationFeedback.updateMany({where:{id,workspaceId},data:{status}});
  if(!result.count)throw new ApiException(404,'反馈不存在。');
  return {id,status};
}

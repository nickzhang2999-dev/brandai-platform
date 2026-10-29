import { prisma } from '@brandai/db';
import type { NotificationItem } from '@brandai/contracts';
import { inspirationEnabled } from './config';

/** Caller enforces current workspace membership. Questions, answers, citations and raw errors never enter the inbox. */
export async function listInspirationNotifications(workspaceId:string,userId:string,limit:number):Promise<NotificationItem[]> {
  if(!inspirationEnabled() || !workspaceId || !userId || !Number.isFinite(limit) || limit<1)return [];
  const rows=await prisma.inspirationChat.findMany({
    where:{workspaceId,userId,status:{in:['SUCCEEDED','FAILED']}},
    select:{id:true,workspaceId:true,userId:true,conversationId:true,status:true,updatedAt:true},
    orderBy:{updatedAt:'desc'},take:Math.min(100,Math.floor(limit)),
  });
  return rows.filter(row=>row.workspaceId===workspaceId && row.userId===userId && ['SUCCEEDED','FAILED'].includes(row.status)).map(row=>({
    id:`inspiration-chat:${row.id}`,kind:'INSPIRATION_CHAT',status:row.status==='SUCCEEDED'?'SUCCEEDED':'FAILED',
    title:row.status==='SUCCEEDED'?'灵感问答已完成':'灵感问答未完成',
    detail:'打开灵感库查看对话记录和当前可用的引用。',
    href:`/inspiration?${new URLSearchParams({workspaceId,conversationId:row.conversationId})}`,
    createdAt:row.updatedAt.toISOString(),
  }));
}

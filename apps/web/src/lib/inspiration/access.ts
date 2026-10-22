import { prisma } from '@brandai/db';
import type { InspirationCaseCard } from '@brandai/contracts';
import { requireWorkspaceRole } from '../workspace';
import { listCases } from './service';

export async function requireActiveEditor(workspaceId:string,userId:string) {
  const user=await prisma.user.findUnique({where:{id:userId},select:{isActive:true}});
  if(!user?.isActive)throw new Error('Account disabled');
  await requireWorkspaceRole(workspaceId,userId,'EDITOR');
}
/** Re-read permission and version immediately before each paid external batch. */
export async function currentAnalysisCases<T extends InspirationCaseCard>(workspaceId:string,userId:string,candidates:T[]):Promise<T[]> {
  await requireActiveEditor(workspaceId,userId);
  const current=(await listCases(workspaceId)).cases;
  return candidates.filter(c=>current.some(now=>now.caseId===c.caseId&&now.revision===c.revision&&now.analysisAllowed));
}
export async function requireCurrentEvidence(workspaceId:string,userId:string,cases:InspirationCaseCard[]) {
  if((await currentAnalysisCases(workspaceId,userId,cases)).length!==cases.length)throw new Error('引用内容已更新，请重新提问。');
}

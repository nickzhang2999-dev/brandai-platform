import { prisma } from '@brandai/db';
import type { InspirationCaseCard } from '@brandai/contracts';
import { requireWorkspaceRole } from '../workspace';
import { currentCases } from './service';
import { canReceiveLibrary, resolveLibrary } from './library';
import type { LibraryScope } from './library-scope';

export async function requireLibraryReceiver(library:LibraryScope,workspaceId:string,userId:string) {
  const user=await prisma.user.findUnique({where:{id:userId},select:{id:true,email:true,isActive:true}});
  if(!user?.isActive)throw new Error('Library receiver access changed');
  try {
    const {role}=await requireWorkspaceRole(workspaceId,userId,'VIEWER');
    const current=await resolveLibrary(workspaceId,library.id);
    if(current.kind!==library.kind||current.ownerId!==library.ownerId||!await canReceiveLibrary(current,user,role))throw new Error('Library receiver access changed');
  }catch(error){
    if(error&&typeof error==='object'&&'status' in error&&[403,404].includes(Number(error.status)))throw new Error('Library receiver access changed');
    throw error;
  }
}

export async function requireActiveEditor(workspaceId:string,userId:string) {
  const user=await prisma.user.findUnique({where:{id:userId},select:{isActive:true}});
  if(!user?.isActive)throw new Error('Account disabled');
  await requireWorkspaceRole(workspaceId,userId,'EDITOR');
}
/** Re-read permission and version immediately before each paid external batch. */
export async function currentAnalysisCases<T extends InspirationCaseCard>(workspaceId:string,userId:string,candidates:T[],libraryId?:string):Promise<T[]> {
  await requireActiveEditor(workspaceId,userId);
  const current=(await currentCases(workspaceId,libraryId,candidates.map(c=>c.caseId))).cases;
  return candidates.filter(c=>current.some(now=>now.caseId===c.caseId&&now.revision===c.revision&&now.analysisAllowed));
}
export async function requireCurrentEvidence(workspaceId:string,userId:string,cases:InspirationCaseCard[],libraryId?:string) {
  if((await currentAnalysisCases(workspaceId,userId,cases,libraryId)).length!==cases.length)throw new Error('引用内容已更新，请重新提问。');
}

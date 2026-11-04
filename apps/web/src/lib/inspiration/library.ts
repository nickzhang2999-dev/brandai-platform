import { prisma, type Prisma } from '@brandai/db';
import { ApiException } from '../api';
import type { LibraryScope } from './library-scope';
export {sourceLibrary} from './library-scope';
function validatedLibraryId(value:string|undefined) {
  const id=value?.trim();
  if(id&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))throw new ApiException(503,'公司灵感库配置无效。');
  return id||null;
}
export function sharedLibraryId() {
  return validatedLibraryId(process.env.INSPIRATION_SHARED_LIBRARY_ID);
}
/** Administrator preparation only; never changes the library resolved for readers. */
export function sharedLibrarySetupId() {
  const setup=validatedLibraryId(process.env.INSPIRATION_SHARED_SETUP_LIBRARY_ID);
  const active=sharedLibraryId();
  return setup||active;
}
/** Caller must first check brand membership. Storage ownership never follows a client ID. */
export async function resolveLibrary(workspaceId:string,requestedId?:string|null):Promise<LibraryScope> {
  const workspace=await prisma.brandWorkspace.findUnique({where:{id:workspaceId},select:{ownerId:true}});
  if(!workspace)throw new ApiException(404,'品牌不存在。');
  const configured=sharedLibraryId(),id=requestedId||configured||workspaceId;
  const library=await prisma.inspirationLibrary.findUnique({where:{id}});
  if(library?.kind==='SHARED'&&library.ownerId===workspace.ownerId){
    const identity=await prisma.inspirationLibraryIdentity.findUnique({where:{id:library.id}});
    if(identity?.ownerId!==library.ownerId)throw new ApiException(503,'公司灵感库的接收身份不一致。');
    return library;
  }
  if(library?.kind==='WORKSPACE'&&library.legacyWorkspaceId===workspaceId&&library.ownerId===workspace.ownerId)return library;
  if(requestedId)throw new ApiException(404,'灵感库不可访问。');
  if(configured&&!library)throw new ApiException(503,'公司灵感库尚未由管理员初始化。');
  // A configured company library never grants other owners access. Their
  // existing private workspace libraries retain the original boundary.
  const own=id===workspaceId?library:await prisma.inspirationLibrary.findUnique({where:{id:workspaceId}});
  if(own&&own.kind==='WORKSPACE'&&own.legacyWorkspaceId===workspaceId&&own.ownerId===workspace.ownerId)return own;
  if(own)throw new ApiException(409,'品牌灵感库身份冲突。');
  return {id:workspaceId,kind:'WORKSPACE',ownerId:workspace.ownerId,legacyWorkspaceId:workspaceId};
}
export async function ensureLibrary(tx:Prisma.TransactionClient,library:LibraryScope) {
  if(library.kind==='WORKSPACE')return tx.inspirationLibrary.upsert({where:{id:library.id},create:library,update:{}});
  const current=await tx.inspirationLibrary.findUnique({where:{id:library.id}});
  const identity=await tx.inspirationLibraryIdentity.findUnique({where:{id:library.id}});
  if(!current||current.kind!=='SHARED'||current.ownerId!==library.ownerId||identity?.ownerId!==library.ownerId)throw new ApiException(409,'公司灵感库配置已变化。');
  return current;
}
export async function canReceiveLibrary(library:LibraryScope,user:{id:string;email?:string|null},role:string) {
  if(library.kind==='WORKSPACE')return role==='OWNER';
  if(user.id===library.ownerId)return true;
  const {isAdminUser}=await import('../admin');
  return isAdminUser(user.id,user.email);
}

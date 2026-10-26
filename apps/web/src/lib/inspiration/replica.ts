import { Prisma, prisma } from '@brandai/db';
import { Manifest, Withdrawal, canonical, sha256, validatePackage, verifySigned, type PublishedCase } from './protocol';
import { boundedBody, syncConfig } from './config';
import { CONTENT_SYNC_ERROR, WITHDRAWAL_SYNC_ERROR } from './sync-status';

type Tx = Prisma.TransactionClient;
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x==='string') : [];
type SyncChannel = 'content' | 'withdrawals';
async function beginCheck(workspaceId: string, channel: SyncChannel) {
  return prisma.$transaction(async tx => {
    await lockWorkspace(tx, workspaceId);
    const state = await tx.inspirationState.upsert({where: {workspaceId}, create: {workspaceId}, update: {}});
    const previous = channel === 'content' ? state.lastSyncAttemptAt : state.lastWithdrawalAttemptAt;
    // Allocate a distinct monotonic attempt timestamp even when two workers
    // begin during the same millisecond. This timestamp also fences outcomes.
    const startedAt = new Date(Math.max(Date.now(), (previous?.getTime() ?? 0) + 1));
    const data = channel === 'content' ? {lastSyncAttemptAt: startedAt} : {lastWithdrawalAttemptAt: startedAt};
    await tx.inspirationState.update({where: {workspaceId}, data});
    return startedAt;
  });
}
async function finishCheck(workspaceId: string, channel: SyncChannel, startedAt: Date, succeeded: boolean) {
  const finishedAt = new Date();
  // A slow older check must not erase a newer attempt's failure or success.
  const where = channel === 'content' ? {workspaceId, lastSyncAttemptAt: startedAt} : {workspaceId, lastWithdrawalAttemptAt: startedAt};
  const data = channel === 'content'
    ? succeeded ? {lastSyncAt: finishedAt, syncError: null, lastError: null} : {lastSyncFailedAt: finishedAt, syncError: CONTENT_SYNC_ERROR}
    : succeeded ? {lastWithdrawalAt: finishedAt, withdrawalError: null} : {lastWithdrawalFailedAt: finishedAt, withdrawalError: WITHDRAWAL_SYNC_ERROR};
  await prisma.inspirationState.updateMany({where, data});
}
export async function lockWorkspace(tx: Tx, workspaceId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inspiration:${workspaceId}`}))`;
}
export async function applyWithdrawal(workspaceId: string, raw: Buffer, keys: Record<string,string>) {
  const w=verifySigned(Withdrawal.parse(JSON.parse(raw.toString('utf8'))),keys), digest=sha256(canonical(w));
  await prisma.$transaction(async tx => {
    await lockWorkspace(tx,workspaceId);
    const state=await tx.inspirationState.upsert({where:{workspaceId},create:{workspaceId},update:{}});
    if(w.sequence < state.withdrawalSequence) throw new Error('Withdrawal rollback');
    if(w.sequence === state.withdrawalSequence) { if(digest!==state.withdrawalHash) throw new Error('Withdrawal conflict'); return; }
    const next=new Set(w.case_ids); if(strings(state.withdrawn).some(id=>!next.has(id))) throw new Error('Withdrawal cannot be undone');
    // Signed cumulative lists can jump to latest: never omit an older accepted revocation.
    await tx.inspirationState.update({where:{workspaceId},data:{withdrawalSequence:w.sequence,withdrawalHash:digest,withdrawn:json([...next])}});
  });
}
export async function installPackage(workspaceId: string, raw: Buffer, files: Map<string,Buffer>, keys: Record<string,string>, signal?:AbortSignal) {
  const {manifest:m,records,mimes}=await validatePackage(raw,files,keys), digest=sha256(raw);
  signal?.throwIfAborted();
  await prisma.$transaction(async tx => {
    await lockWorkspace(tx,workspaceId);
    const state=await tx.inspirationState.upsert({where:{workspaceId},create:{workspaceId},update:{}});
    const previous=await tx.inspirationRelease.findUnique({where:{workspaceId_releaseId:{workspaceId,releaseId:m.release_id}}});
    if(previous) { if(previous.manifestHash!==digest || previous.sequence!==m.sequence) throw new Error('Immutable release conflict'); return; }
    if(m.sequence<=state.releaseSequence) throw new Error('Release rollback');
    if(m.kind==='delta' && (m.sequence!==state.releaseSequence+1 || m.parent_release_id!==state.activeRelease)) throw new Error('Missing delta predecessor; publish a full checkpoint');
    const active=state.activeRelease ? await tx.inspirationRelease.findUnique({where:{workspaceId_releaseId:{workspaceId,releaseId:state.activeRelease}}}) : null;
    const snapshot: Record<string,string> = m.kind==='delta' && active ? {...active.snapshot as Record<string,string>} : {};
    const withdrawn=new Set(strings(state.withdrawn));
    for(const r of records) {
      signal?.throwIfAborted();
      const imageHash=sha256(canonical(r.case?.images.map(i=>({path:i.path,sha256:m.files.find(f=>f.path===i.path)!.sha256})).sort((a,b)=>a.path.localeCompare(b.path)) ?? []));
      const old=await tx.inspirationRecord.findFirst({where:{workspaceId,caseId:r.case_id},orderBy:{revision:'desc'}});
      if(old && (r.revision<old.revision || (r.revision===old.revision && (r.content_hash!==old.contentHash || imageHash!==old.imageHash)))) throw new Error('Case revision conflict');
      if(r.op==='upsert' && withdrawn.has(r.case_id)) throw new Error('Withdrawn case cannot be restored');
      const row=old && old.revision===r.revision ? old : await tx.inspirationRecord.create({data:{workspaceId,caseId:r.case_id,revision:r.revision,contentHash:r.content_hash,imageHash,releaseId:m.release_id,deleted:r.op==='delete',body:json(r.case ?? {})}});
      if(r.op==='delete') delete snapshot[r.case_id]; else snapshot[r.case_id]=row.id;
    }
    for(const [path,mimeType] of mimes) await tx.inspirationImage.create({data:{workspaceId,releaseId:m.release_id,path,mimeType,sha256:sha256(files.get(path)!),bytes:new Uint8Array(files.get(path)!)}});
    for(const id of withdrawn) delete snapshot[id];
    await tx.inspirationRelease.create({data:{workspaceId,releaseId:m.release_id,sequence:m.sequence,manifestHash:digest,manifest:json(m),snapshot:json(snapshot)}});
    signal?.throwIfAborted();
    await tx.inspirationState.update({where:{workspaceId},data:{activeRelease:m.release_id,releaseSequence:m.sequence}});
  },{timeout:120000,maxWait:10000});
}
export async function rollbackReplica(workspaceId:string, releaseId:string) {
  await prisma.$transaction(async tx=> { await lockWorkspace(tx,workspaceId);
    const target=await tx.inspirationRelease.findUnique({where:{workspaceId_releaseId:{workspaceId,releaseId}}}); if(!target) throw new Error('Unknown local release');
    // High-water marks and withdrawals are deliberately not rolled back.
    await tx.inspirationState.update({where:{workspaceId},data:{activeRelease:releaseId}});
  });
}
export async function syncReplica(workspaceId: string, signal: AbortSignal) {
  const startedAt = await beginCheck(workspaceId, 'content');
  try {
    await syncReplicaContent(workspaceId, signal);
    signal.throwIfAborted();
    await finishCheck(workspaceId, 'content', startedAt, true);
  } catch (error) {
    await finishCheck(workspaceId, 'content', startedAt, false);
    throw error;
  }
}
async function syncReplicaContent(workspaceId: string, signal: AbortSignal) {
  const c=syncConfig(); if(!c) throw new Error('Publisher is not configured');
  const fetchPath=async(path:string,max:number)=>boundedBody(await fetch(`${c.baseUrl}${path}`,{headers:{Authorization:`Bearer ${c.token}`},redirect:'error',signal,cache:'no-store'}),max);
  // Withdrawal failure stops sync; content never advances while revocations are unknown.
  await syncWithdrawals(workspaceId, signal);
  const latest=JSON.parse((await fetchPath('/latest',65536)).toString('utf8'));
  if(latest.status==='empty') {
    const state = await prisma.inspirationState.findUnique({where: {workspaceId}});
    if(state?.releaseSequence) throw new Error('Release discovery rollback');
    return;
  }
  const pointer=latest.release;
  if(!pointer || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pointer.release_id)) throw new Error('Invalid release discovery');
  const raw=await fetchPath(`/releases/${pointer.release_id}/manifest`,4*1024*1024);
  const m=verifySigned(Manifest.parse(JSON.parse(raw.toString('utf8'))),c.keys);
  if(sha256(raw)!==pointer.manifest_sha256 || m.release_id!==pointer.release_id || m.sequence!==pointer.sequence) throw new Error('Discovery mismatch');
  if(m.files.reduce((n,f)=>n+f.size,0)>128*1024*1024) throw new Error('Trial package exceeds limit');
  const state=await prisma.inspirationState.findUnique({where:{workspaceId}});
  if(state && m.sequence<state.releaseSequence)throw new Error('Release discovery rollback');
  const known=await prisma.inspirationRelease.findUnique({where:{workspaceId_releaseId:{workspaceId,releaseId:m.release_id}}});
  if(known){if(known.manifestHash!==sha256(raw)||known.sequence!==m.sequence)throw new Error('Immutable release conflict');return;}
  const chain:Array<{raw:Buffer;m:Manifest}>=[{raw,m}];let cursor=m,total=m.files.reduce((n,f)=>n+f.size,0);
  while(cursor.kind==='delta' && cursor.parent_release_id!==state?.activeRelease) {
    if(chain.length>=32)throw new Error('Delta chain exceeds trial limit; full checkpoint required');
    const parentRaw=await fetchPath(`/releases/${cursor.parent_release_id}/manifest`,4*1024*1024);
    const parent=verifySigned(Manifest.parse(JSON.parse(parentRaw.toString('utf8'))),c.keys);
    if(parent.release_id!==cursor.parent_release_id || parent.sequence!==cursor.sequence-1)throw new Error('Invalid ancestry');
    total+=parent.files.reduce((n,f)=>n+f.size,0);if(total>256*1024*1024)throw new Error('Sync batch exceeds trial limit');
    chain.push({raw:parentRaw,m:parent});cursor=parent;
  }
  for(const release of chain.reverse()) {
    const existing=await prisma.inspirationRelease.findUnique({where:{workspaceId_releaseId:{workspaceId,releaseId:release.m.release_id}}});
    if(existing) {if(existing.manifestHash!==sha256(release.raw))throw new Error('Immutable release conflict');continue;}
    const files=new Map<string,Buffer>(); for(const f of release.m.files) files.set(f.path,await fetchPath(`/releases/${release.m.release_id}/files/${f.path.split('/').map(encodeURIComponent).join('/')}`,Math.min(f.size,128*1024*1024)));
    await installPackage(workspaceId,release.raw,files,c.keys,signal);
  }
}
export async function syncWithdrawals(workspaceId:string,signal:AbortSignal) {
  const startedAt = await beginCheck(workspaceId, 'withdrawals');
  try {
    const c=syncConfig();if(!c)throw new Error('Publisher is not configured');
    const response=await fetch(`${c.baseUrl}/withdrawals/latest`,{headers:{Authorization:`Bearer ${c.token}`},redirect:'error',signal,cache:'no-store'});
    const value=JSON.parse((await boundedBody(response,8*1024*1024)).toString('utf8'));
    if(value.withdrawal)await applyWithdrawal(workspaceId,Buffer.from(JSON.stringify(value.withdrawal)),c.keys);
    else if(value.status!=='empty')throw new Error('Invalid withdrawal discovery');
    else {
      const state = await prisma.inspirationState.findUnique({where: {workspaceId}});
      if(state?.withdrawalSequence)throw new Error('Withdrawal discovery rollback');
    }
    signal.throwIfAborted();
    await finishCheck(workspaceId, 'withdrawals', startedAt, true);
  } catch(error) {
    await finishCheck(workspaceId, 'withdrawals', startedAt, false);
    throw error;
  }
}
export async function activeRecords(workspaceId:string) {
  const state=await prisma.inspirationState.findUnique({where:{workspaceId}});
  const release=state?.activeRelease ? await prisma.inspirationRelease.findUnique({where:{workspaceId_releaseId:{workspaceId,releaseId:state.activeRelease}}}) : null;
  const withdrawn=new Set(strings(state?.withdrawn)); const snapshot=(release?.snapshot ?? {}) as Record<string,string>;
  const ids=Object.entries(snapshot).filter(([id])=>!withdrawn.has(id)).map(([,id])=>id);
  const records=await prisma.inspirationRecord.findMany({where:{workspaceId,id:{in:ids},deleted:false}});
  return {state,release,records:records.filter(r=>(r.body as unknown as PublishedCase).display_permission==='allowed')};
}

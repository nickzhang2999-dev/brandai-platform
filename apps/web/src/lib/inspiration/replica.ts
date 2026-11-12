import {readPublisher} from './publisher-fetch';
import { Prisma, prisma } from '@brandai/db';
import { Manifest, Withdrawal, canonical, checkedPackageSize, sha256, validatePackage, validatePackageMetadata, verifySigned, type PublishedCase } from './protocol';
import { boundedBody, receiverOrigin, syncConfig, syncSizeLimits } from './config';
import { CONTENT_SYNC_ERROR, WITHDRAWAL_SYNC_ERROR, DAILY_IMAGE_LIMIT_CODE } from './sync-status';
import { assertEnvelopeScope, assertPublicationScope, publicationUseBasis } from './publication-scope';
import { libraryScope, type LibraryInput, type LibraryScope } from './library-scope';
import { beginDailyReceipt, dailyReceiptsEnabled, recordDailyReceipt, DailyReceiptLimit } from './daily-receipts';
import {isSnapshotRelease,assertSnapshotReadScope} from './snapshot-catalog';
import type {SnapshotContinuation} from './snapshot-sync';

type Tx = Prisma.TransactionClient;
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x==='string') : [];
type SyncChannel = 'content' | 'withdrawals';
async function beginCheck(libraryId: string, channel: SyncChannel) {
  return prisma.$transaction(async tx => {
    await lockLibrary(tx, libraryId);
    const state = await tx.inspirationState.upsert({where: {libraryId}, create: {libraryId}, update: {}});
    const previous = channel === 'content' ? state.lastSyncAttemptAt : state.lastWithdrawalAttemptAt;
    // Allocate a distinct monotonic attempt timestamp even when two workers
    // begin during the same millisecond. This timestamp also fences outcomes.
    const startedAt = new Date(Math.max(Date.now(), (previous?.getTime() ?? 0) + 1));
    const data = channel === 'content' ? {lastSyncAttemptAt: startedAt} : {lastWithdrawalAttemptAt: startedAt};
    await tx.inspirationState.update({where: {libraryId}, data});
    return startedAt;
  });
}
async function finishCheck(libraryId: string, channel: SyncChannel, startedAt: Date, succeeded: boolean, dailyLimit=false) {
  const finishedAt = new Date();
  // A slow older check must not erase a newer attempt's failure or success.
  const where = channel === 'content' ? {libraryId, lastSyncAttemptAt: startedAt} : {libraryId, lastWithdrawalAttemptAt: startedAt};
  const data = channel === 'content'
    ? succeeded ? {lastSyncAt: finishedAt, syncError: null, lastError: null} : {lastSyncFailedAt: finishedAt, syncError: dailyLimit?DAILY_IMAGE_LIMIT_CODE:CONTENT_SYNC_ERROR}
    : succeeded ? {lastWithdrawalAt: finishedAt, withdrawalError: null} : {lastWithdrawalFailedAt: finishedAt, withdrawalError: WITHDRAWAL_SYNC_ERROR};
  await prisma.inspirationState.updateMany({where, data});
}
export async function lockLibrary(tx: Tx, libraryId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inspiration-library:${libraryId}`}))`;
}
// Compatibility name for existing callers; the lock key is now library-owned.
export const lockWorkspace=lockLibrary;
async function assertSnapshotScope(db: Pick<Tx, 'inspirationRecord'>, library: LibraryScope, snapshot: unknown, withdrawn: Set<string>) {
  const libraryId=library.id;
  const ids=Object.entries((snapshot ?? {}) as Record<string,string>).filter(([caseId])=>!withdrawn.has(caseId)).map(([,recordId])=>recordId);
  if(!ids.length)return;
  const rows=await db.inspirationRecord.findMany({where:{libraryId,id:{in:ids},deleted:false}});
  for(const row of rows)assertPublicationScope(row.body as unknown as PublishedCase,library,receiverOrigin());
}
export async function applyWithdrawal(input: LibraryInput, raw: Buffer, keys: Record<string,string>) {
  const library=libraryScope(input),libraryId=library.id;
  const w=verifySigned(Withdrawal.parse(JSON.parse(raw.toString('utf8'))),keys), digest=sha256(canonical(w));
  assertEnvelopeScope(w,library,receiverOrigin());
  await prisma.$transaction(async tx => {
    await lockLibrary(tx,libraryId);
    const state=await tx.inspirationState.upsert({where:{libraryId},create:{libraryId},update:{}});
    if(w.sequence < state.withdrawalSequence) throw new Error('Withdrawal rollback');
    if(w.sequence === state.withdrawalSequence) { if(digest!==state.withdrawalHash) throw new Error('Withdrawal conflict'); return; }
    const next=new Set(w.case_ids); if(strings(state.withdrawn).some(id=>!next.has(id))) throw new Error('Withdrawal cannot be undone');
    // Signed cumulative lists can jump to latest: never omit an older accepted revocation.
    await tx.inspirationState.update({where:{libraryId},data:{withdrawalSequence:w.sequence,withdrawalHash:digest,withdrawn:json([...next])}});
  });
}
export async function installPackage(input: LibraryInput, raw: Buffer, files: Map<string,Buffer>, keys: Record<string,string>, signal?:AbortSignal,beforeImport?:()=>Promise<void>) {
  const library=libraryScope(input),libraryId=library.id;
  assertEnvelopeScope(verifySigned(Manifest.parse(JSON.parse(raw.toString())),keys),library,receiverOrigin());
  const {manifest:m,records,mimes}=await validatePackage(raw,files,keys), digest=sha256(raw);
  for (const record of records) if (record.case) {
    assertPublicationScope(record.case, library, receiverOrigin());
    const basis = publicationUseBasis(record.case);
    if (basis && m.files.find(file => file.path === record.case!.images[0]!.path)?.sha256 !== basis.sha256) throw new Error('Publication image checksum mismatch');
  }
  signal?.throwIfAborted();
  await prisma.$transaction(async tx => {
    await lockLibrary(tx,libraryId);
    await beforeImport?.();
    const state=await tx.inspirationState.upsert({where:{libraryId},create:{libraryId},update:{}});
    const previous=await tx.inspirationRelease.findUnique({where:{libraryId_releaseId:{libraryId,releaseId:m.release_id}}});
    if(previous) { if(previous.manifestHash!==digest || previous.sequence!==m.sequence) throw new Error('Immutable release conflict'); return; }
    const candidateOwner=dailyReceiptsEnabled()?await tx.inspirationLibrary.findUnique({where:{id:libraryId},select:{ownerId:true}}):null;
    if(dailyReceiptsEnabled()&&!candidateOwner)throw new Error('Unknown receipt library owner');
    const receiptOwner=candidateOwner&&dailyReceiptsEnabled(candidateOwner.ownerId)?candidateOwner:null;
    const receiptPolicy=receiptOwner?await beginDailyReceipt(tx,receiptOwner.ownerId):null;
    if(m.sequence<=state.releaseSequence) throw new Error('Release rollback');
    if(m.kind==='delta' && (m.sequence!==state.releaseSequence+1 || m.parent_release_id!==state.activeRelease)) throw new Error('Missing delta predecessor; publish a full checkpoint');
    const active=state.activeRelease ? await tx.inspirationRelease.findUnique({where:{libraryId_releaseId:{libraryId,releaseId:state.activeRelease}}}) : null;
    const snapshot: Record<string,string> = m.kind==='delta' && active ? {...active.snapshot as Record<string,string>} : {};
    const withdrawn=new Set(strings(state.withdrawn));
    if(m.kind==='delta' && active)await assertSnapshotScope(tx,library,active.snapshot,withdrawn);
    for(const r of records) {
      signal?.throwIfAborted();
      const imageHash=sha256(canonical(r.case?.images.map(i=>({path:i.path,sha256:m.files.find(f=>f.path===i.path)!.sha256})).sort((a,b)=>a.path.localeCompare(b.path)) ?? []));
      const old=await tx.inspirationRecord.findFirst({where:{libraryId,caseId:r.case_id},orderBy:{revision:'desc'}});
      if(old && (r.revision<old.revision || (r.revision===old.revision && (r.content_hash!==old.contentHash || imageHash!==old.imageHash)))) throw new Error('Case revision conflict');
      // A case in the cumulative withdrawn set may still appear in older releases:
      // a fresh install replays history that predates the withdrawal, and its
      // `delete` records (or the snapshot sweep below) keep it out of the active
      // set. Persist the record for audit, never the snapshot entry. Creating a
      // snapshot entry for a withdrawn case is the actual restore, and the sweep
      // below removes it either way, so the final invariant "withdrawn cases are
      // not in the active snapshot" holds regardless of replay order.
      const suppressed = r.op === 'upsert' && withdrawn.has(r.case_id);
      const row=old && old.revision===r.revision ? old : await tx.inspirationRecord.create({data:{libraryId,caseId:r.case_id,revision:r.revision,contentHash:r.content_hash,imageHash,releaseId:m.release_id,deleted:r.op==='delete',body:json(r.case ?? {})}});
      if(r.op==='delete') delete snapshot[r.case_id]; else if(!suppressed) snapshot[r.case_id]=row.id;
    }
    for(const [path,mimeType] of mimes) await tx.inspirationImage.create({data:{libraryId,releaseId:m.release_id,path,mimeType,sha256:sha256(files.get(path)!),bytes:new Uint8Array(files.get(path)!)}});
    for(const id of withdrawn) delete snapshot[id];
    await tx.inspirationRelease.create({data:{libraryId,releaseId:m.release_id,sequence:m.sequence,manifestHash:digest,manifest:json(m),snapshot:json(snapshot)}});
    signal?.throwIfAborted();
    await beforeImport?.();
    await tx.inspirationState.update({where:{libraryId},data:{activeRelease:m.release_id,releaseSequence:m.sequence}});
    if(receiptOwner&&receiptPolicy) {
      const hashes=records.filter(r=>r.op==='upsert'&&r.case?.display_permission==='allowed'&&snapshot[r.case_id]&&!withdrawn.has(r.case_id))
        .flatMap(r=>r.case!.images.map(image=>m.files.find(file=>file.path===image.path)!.sha256));
      await recordDailyReceipt(tx,{ownerId:receiptOwner.ownerId,libraryId,releaseId:m.release_id,hashes,target:receiptPolicy.target});
    }
  },{timeout:120000,maxWait:10000});
}
export async function rollbackReplica(input:LibraryInput, releaseId:string) {
  const library=libraryScope(input),libraryId=library.id;
  await prisma.$transaction(async tx=> { await lockLibrary(tx,libraryId);
    const target=await tx.inspirationRelease.findUnique({where:{libraryId_releaseId:{libraryId,releaseId}}}); if(!target) throw new Error('Unknown local release');
    const state=await tx.inspirationState.findUnique({where:{libraryId}});
    if(isSnapshotRelease(target))assertSnapshotReadScope(target,library);
    else await assertSnapshotScope(tx,library,target.snapshot,new Set(strings(state?.withdrawn)));
    // High-water marks and withdrawals are deliberately not rolled back.
    await tx.inspirationState.update({where:{libraryId},data:{activeRelease:releaseId}});
  });
}
export async function syncReplica(input: LibraryInput, signal: AbortSignal,beforeImport?:()=>Promise<void>,continuation:SnapshotContinuation={}) {
  const library=libraryScope(input),libraryId=library.id;
  const startedAt = await beginCheck(libraryId, 'content');
  try {
    await beforeImport?.();
    const result=await syncReplicaContent(library, signal,beforeImport,continuation);
    signal.throwIfAborted();
    if(result&&!result.complete)return result;
    await finishCheck(libraryId, 'content', startedAt, true);
    return result;
  } catch (error) {
    await finishCheck(libraryId, 'content', startedAt, false,error instanceof DailyReceiptLimit);
    throw error;
  }
}
async function syncReplicaContent(library: LibraryScope, signal: AbortSignal,beforeImport?:()=>Promise<void>,continuation:SnapshotContinuation={}) {
  const libraryId=library.id;
  const c=syncConfig(library.kind); if(!c) throw new Error('Publisher is not configured');
  const limits=syncSizeLimits();
  const fetchPath=async(path:string,max:number)=>boundedBody(await fetch(`${c.baseUrl}${path}`,{headers:{Authorization:`Bearer ${c.token}`},redirect:'error',signal,cache:'no-store'}),max);
  // Withdrawal failure stops sync; content never advances while revocations are unknown.
  await syncWithdrawals(library, signal);
  if(library.kind==='SHARED'&&process.env.INSPIRATION_SNAPSHOT_V3_ENABLED==='true') {
    const {synchronizeSnapshot}=await import('./snapshot-sync');
    const result=await synchronizeSnapshot(library,signal,beforeImport??(async()=>{}),continuation);
    if(result)return result;
    const state=await prisma.inspirationState.findUnique({where:{libraryId}});
    const current=state?.activeRelease?await prisma.inspirationRelease.findUnique({where:{libraryId_releaseId:{libraryId,releaseId:state.activeRelease}}}):null;
    if(isSnapshotRelease(current))throw new Error('Snapshot discovery rollback');
  }else if(continuation.sessionId)throw new Error('snapshot_v3_disabled');
  const latest=JSON.parse((await fetchPath('/latest',65536)).toString('utf8'));
  assertEnvelopeScope({...latest,schema_version:latest.schema_version??1},library,receiverOrigin());
  if(latest.status==='empty') {
    const state = await prisma.inspirationState.findUnique({where: {libraryId}});
    if(state?.releaseSequence) throw new Error('Release discovery rollback');
    return;
  }
  const pointer=latest.release;
  if(!pointer || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pointer.release_id)) throw new Error('Invalid release discovery');
  const raw=await fetchPath(`/releases/${pointer.release_id}/manifest`,4*1024*1024);
  const m=verifySigned(Manifest.parse(JSON.parse(raw.toString('utf8'))),c.keys);
  assertEnvelopeScope(m,library,receiverOrigin());
  if(sha256(raw)!==pointer.manifest_sha256 || m.release_id!==pointer.release_id || m.sequence!==pointer.sequence) throw new Error('Discovery mismatch');
  const latestBytes=checkedPackageSize(m);
  const state=await prisma.inspirationState.findUnique({where:{libraryId}});
  if(state && m.sequence<state.releaseSequence)throw new Error('Release discovery rollback');
  const known=await prisma.inspirationRelease.findUnique({where:{libraryId_releaseId:{libraryId,releaseId:m.release_id}}});
  if(known){if(known.manifestHash!==sha256(raw)||known.sequence!==m.sequence)throw new Error('Immutable release conflict');await assertSnapshotScope(prisma,library,known.snapshot,new Set(strings(state?.withdrawn)));return;}
  const chain:Array<{raw:Buffer;m:Manifest}>=[{raw,m}];let cursor=m,total=latestBytes;
  while(cursor.kind==='delta' && cursor.parent_release_id!==state?.activeRelease) {
    if(chain.length>=32)throw new Error('Delta chain exceeds trial limit; full checkpoint required');
    const parentRaw=await fetchPath(`/releases/${cursor.parent_release_id}/manifest`,4*1024*1024);
    const parent=verifySigned(Manifest.parse(JSON.parse(parentRaw.toString('utf8'))),c.keys);
    assertEnvelopeScope(parent,library,receiverOrigin());
    if(parent.release_id!==cursor.parent_release_id || parent.sequence!==cursor.sequence-1)throw new Error('Invalid ancestry');
    total+=checkedPackageSize(parent);if(total>limits.syncBytes)throw new Error('Sync batch exceeds configured size limit');
    chain.push({raw:parentRaw,m:parent});cursor=parent;
  }
  // Authenticate all record metadata and destination scopes before the first
  // image request. A wrong library must fail promptly without a large download.
  const prepared:Array<{raw:Buffer;m:Manifest;recordsBytes:Buffer}>=[];
  for(const release of chain.reverse()) {
    const entry=release.m.files.find(f=>f.path==='records.jsonl');if(!entry)throw new Error('Incomplete package');
    const recordsBytes=await fetchPath(`/releases/${release.m.release_id}/files/records.jsonl`,Math.min(entry.size,128*1024*1024));
    const metadata=validatePackageMetadata(release.raw,recordsBytes,c.keys);
    assertEnvelopeScope(metadata.manifest,library,receiverOrigin());
    for(const record of metadata.records)if(record.case)assertPublicationScope(record.case,library,receiverOrigin());
    prepared.push({...release,recordsBytes});
  }
  for(const release of prepared) {
    await beforeImport?.();
    const existing=await prisma.inspirationRelease.findUnique({where:{libraryId_releaseId:{libraryId,releaseId:release.m.release_id}}});
    if(existing) {if(existing.manifestHash!==sha256(release.raw))throw new Error('Immutable release conflict');await assertSnapshotScope(prisma,library,existing.snapshot,new Set(strings(state?.withdrawn)));continue;}
    const files=new Map<string,Buffer>([['records.jsonl',release.recordsBytes]]);
    for(const f of release.m.files)if(f.path!=='records.jsonl')files.set(f.path,await fetchPath(`/releases/${release.m.release_id}/files/${f.path.split('/').map(encodeURIComponent).join('/')}`,Math.min(f.size,20*1024*1024)));
    await installPackage(library,release.raw,files,c.keys,signal,beforeImport);
  }
}
export async function syncWithdrawals(input:LibraryInput,signal:AbortSignal) {
  const library=libraryScope(input),libraryId=library.id;
  const startedAt = await beginCheck(libraryId, 'withdrawals');
  try {
    const c=syncConfig(library.kind);if(!c)throw new Error('Publisher is not configured');
    const raw=await readPublisher(`${c.baseUrl}/withdrawals/latest`,c.token,8*1024*1024,signal,'withdrawals');
    const value=JSON.parse(raw.toString('utf8'));
    assertEnvelopeScope({...value,schema_version:value.schema_version??1},library,receiverOrigin());
    if(value.withdrawal)await applyWithdrawal(library,Buffer.from(JSON.stringify(value.withdrawal)),c.keys);
    else if(value.status!=='empty')throw new Error('Invalid withdrawal discovery');
    else {
      const state = await prisma.inspirationState.findUnique({where: {libraryId}});
      if(state?.withdrawalSequence)throw new Error('Withdrawal discovery rollback');
    }
    signal.throwIfAborted();
    await finishCheck(libraryId, 'withdrawals', startedAt, true);
  } catch(error) {
    await finishCheck(libraryId, 'withdrawals', startedAt, false);
    throw error;
  }
}
export async function activeRecords(input:LibraryInput,options:{caseIds?:readonly string[];skipSnapshotRecords?:boolean;take?:number}={}) {
  const library=libraryScope(input),libraryId=library.id;
  const state=await prisma.inspirationState.findUnique({where:{libraryId}});
  const release=state?.activeRelease ? await prisma.inspirationRelease.findUnique({where:{libraryId_releaseId:{libraryId,releaseId:state.activeRelease}}}) : null;
  if(isSnapshotRelease(release)) {
    assertSnapshotReadScope(release!,library);
    const {readSnapshotCatalog}=await import('./snapshot-import');
    const records=options.skipSnapshotRecords||options.caseIds?.length===0?[]:await readSnapshotCatalog(libraryId,release!.releaseId,{caseIds:options.caseIds?[...options.caseIds]:undefined,take:options.take??Math.max(500,options.caseIds?.length??0),excludedCaseIds:strings(state?.withdrawn)});
    return {state,release,records:records.filter(row=>{try{const body=row.body as unknown as PublishedCase;assertPublicationScope(body,library,receiverOrigin());return body.display_permission==='allowed';}catch{return false;}})};
  }
  const withdrawn=new Set(strings(state?.withdrawn)); const snapshot=(release?.snapshot ?? {}) as Record<string,string>;
  const ids=Object.entries(snapshot).filter(([id])=>!withdrawn.has(id)).map(([,id])=>id);
  const records=await prisma.inspirationRecord.findMany({where:{libraryId,id:{in:ids},deleted:false,...(options.caseIds?{caseId:{in:[...options.caseIds]}}:{})}});
  return {state,release,records:records.filter(r=>{
    const body=r.body as unknown as PublishedCase;
    if(body.display_permission!=='allowed')return false;
    try {assertPublicationScope(body,library,receiverOrigin());return true;} catch {return false;}
  })};
}

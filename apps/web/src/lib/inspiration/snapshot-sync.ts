import {randomUUID} from 'node:crypto';
import {prisma} from '@brandai/db';
import type {LibraryScope} from './library-scope';
import {boundedBody,receiverOrigin,syncConfig} from './config';
import {canonical,sha256} from './protocol';
import {LibraryRecipient} from './publication-scope';
import {createSnapshotImport,syncSnapshotTick} from './snapshot-import';
import {validateSnapshotManifest} from './snapshot-protocol';

export type SnapshotContinuation={sessionId?:string;workerId?:string;onSession?:(sessionId:string)=>Promise<void>};
export async function synchronizeSnapshot(library:LibraryScope,signal:AbortSignal,beforeImport:()=>Promise<void>,continuation:SnapshotContinuation={}) {
  const config=syncConfig(library.kind);if(!config)throw new Error('Publisher is not configured');
  const fetchPath=async(path:string,max:number)=>boundedBody(await fetch(`${config.baseUrl}${path}`,{headers:{Authorization:`Bearer ${config.token}`},redirect:'error',signal,cache:'no-store'}),max);
  let session=continuation.sessionId?await prisma.inspirationSnapshotImport.findUnique({where:{id:continuation.sessionId}}):null;
  if(continuation.sessionId&&(!session||session.libraryId!==library.id))throw new Error('snapshot_import_scope_mismatch');
  if(!session) {
    const latest=JSON.parse((await fetchPath('/snapshots/latest',65536)).toString('utf8'));
    const recipient=LibraryRecipient.parse(latest.recipient);
    if(latest.schema_version!==3||recipient.library_id!==library.id||recipient.origin!==receiverOrigin())throw new Error('Publication recipient mismatch');
    if(latest.status==='empty'&&latest.release===null)return null;
    const pointer=latest.release;
    if(latest.status!=='published'||!pointer||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pointer.release_id)||!Number.isSafeInteger(pointer.sequence)||pointer.sequence<1||! /^[a-f0-9]{64}$/.test(pointer.manifest_sha256))throw new Error('Invalid snapshot discovery');
    const raw=await fetchPath(`/snapshots/releases/${pointer.release_id}/manifest`,1024*1024);
    if(sha256(raw)!==pointer.manifest_sha256)throw new Error('Snapshot discovery checksum mismatch');
    const state=await prisma.inspirationState.findUnique({where:{libraryId:library.id},select:{releaseSequence:true}});
    if(state&&pointer.sequence<state.releaseSequence)throw new Error('Release rollback');
    session=await createSnapshotImport(library,raw,config.keys);
    if(session.sequence!==pointer.sequence||session.releaseId!==pointer.release_id)throw new Error('Snapshot discovery identity mismatch');
  }
  // A durable session pins content, not trust. Keys and recipient configuration
  // may have changed between worker ticks, so never reuse a prior validation.
  const pinned=session;
  const assertCurrentTrust=()=>{
    const current=syncConfig(library.kind);
    if(!current)throw new Error('Publisher is not configured');
    const raw=Buffer.from(canonical(pinned.manifest)+'\n');
    if(sha256(raw)!==pinned.rootHash)throw new Error('Snapshot pinned root checksum mismatch');
    const recipient=LibraryRecipient.parse({kind:'library',library_id:library.id,origin:receiverOrigin()});
    const manifest=validateSnapshotManifest(raw,current.keys,recipient);
    if(manifest.release_id!==pinned.releaseId||manifest.sequence!==pinned.sequence)throw new Error('Snapshot pinned identity mismatch');
  };
  assertCurrentTrust();
  await continuation.onSession?.(session.id);
  const base=`/snapshots/releases/${encodeURIComponent(session.releaseId)}`;
  const result=await syncSnapshotTick(library,{sessionId:session.id,workerId:continuation.workerId??randomUUID(),signal,
    fetchPart:(hash,max)=>fetchPath(`${base}/parts/${hash}`,max),fetchObject:(hash,max)=>fetchPath(`${base}/objects/${hash}`,max),beforeActivate:async()=>{signal.throwIfAborted();await beforeImport();assertCurrentTrust();}});
  if(['FAILED_VALIDATION','CANCELLED'].includes(result.status))throw new Error('snapshot_validation_failed');
  return result;
}

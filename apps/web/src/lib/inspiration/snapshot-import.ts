import { randomUUID } from 'node:crypto';
import { Prisma, prisma } from '@brandai/db';
import { receiverOrigin } from './config';
import { catalogMetadata, catalogSearchText } from './catalog';
import type { LibraryScope } from './library-scope';
import { canonical, sha256 } from './protocol';
import { beginDailyReceipt, dailyReceiptsEnabled, DailyReceiptLimit, recordSnapshotDailyReceipt } from './daily-receipts';
import { validateSnapshotManifest, validateSnapshotPart, validateSnapshotObject, type SnapshotManifest, type SnapshotPart, type SnapshotPartDescriptor, type SnapshotObjectDescriptor } from './snapshot-protocol';

type Tx = Prisma.TransactionClient;
type Lease = {id:string;libraryId:string;workerId:string;epoch:number};
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const MiB=1024*1024;
export const snapshotV3Enabled=()=>process.env.INSPIRATION_SNAPSHOT_V3_ENABLED==='true';
const enabled=()=>{if(!snapshotV3Enabled())throw new Error('snapshot_v3_disabled');};
const lock=async(tx:Tx,libraryId:string)=>{await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inspiration-library:${libraryId}`}))`;};
const expected=(library:LibraryScope)=>{
  if(library.kind!=='SHARED')throw new Error('snapshot_shared_library_required');
  const origin=receiverOrigin();if(!origin)throw new Error('snapshot_recipient_origin_missing');
  return {kind:'library' as const,origin,library_id:library.id};
};
const bound=(value:number|undefined,fallback:number,max:number)=>{
  const n=value??fallback;if(!Number.isSafeInteger(n)||n<1||n>max)throw new Error('snapshot_invalid_budget');return n;
};
function stagingLimit(){const n=Number(process.env.INSPIRATION_SNAPSHOT_STAGING_BYTES??2*1024*MiB);return bound(n,2*1024*MiB,100*1024*MiB);}
class CapacityLimit extends Error {constructor(){super('snapshot_staging_capacity_exceeded');}}
class InvalidSnapshot extends Error {constructor(){super('snapshot_validation_failed');}}
export class SnapshotLeaseLost extends Error {constructor(){super('snapshot_import_lease_lost');}}
async function occupiedBytes(tx:Pick<Tx,'inspirationSnapshotObject'|'inspirationSnapshotCatalogPart'>,libraryId:string){
  const [images,parts]=await Promise.all([tx.inspirationSnapshotObject.aggregate({where:{libraryId},_sum:{size:true}}),tx.inspirationSnapshotCatalogPart.aggregate({where:{libraryId},_sum:{size:true}})]);
  return (images._sum.size??0)+(parts._sum.size??0);
}
async function fenced(tx:Tx,lease:Lease){
  await lock(tx,lease.libraryId);
  const row=await tx.inspirationSnapshotImport.findUniqueOrThrow({where:{id:lease.id}});
  if(row.libraryId!==lease.libraryId||row.leaseOwner!==lease.workerId||row.leaseEpoch!==lease.epoch||!row.leaseUntil||row.leaseUntil.getTime()<=Date.now())throw new SnapshotLeaseLost();
  return row;
}

/** Authentication of a new root never rewrites an already pinned intent. */
export async function createSnapshotImport(library:LibraryScope,raw:Buffer,keys:Record<string,string>){
  enabled();const manifest=validateSnapshotManifest(raw,keys,expected(library)),rootHash=sha256(raw);
  return prisma.$transaction(async tx=>{
    await lock(tx,library.id);
    const actual=await tx.inspirationLibrary.findUniqueOrThrow({where:{id:library.id}});
    if(actual.ownerId!==library.ownerId||actual.kind!==library.kind)throw new Error('snapshot_library_scope_changed');
    const old=await tx.inspirationSnapshotImport.findUnique({where:{libraryId_releaseId:{libraryId:library.id,releaseId:manifest.release_id}}});
    if(old){if(old.rootHash!==rootHash||old.sequence!==manifest.sequence)throw new Error('snapshot_root_conflict');return old;}
    const installed=await tx.inspirationRelease.findUnique({where:{libraryId_releaseId:{libraryId:library.id,releaseId:manifest.release_id}}});
    if(installed&&(installed.manifestHash!==rootHash||installed.sequence!==manifest.sequence))throw new Error('Immutable release conflict');
    const state=await tx.inspirationState.findUnique({where:{libraryId:library.id}});
    if(!installed&&state&&manifest.sequence<=state.releaseSequence)throw new Error('Release rollback');
    return tx.inspirationSnapshotImport.create({data:{libraryId:library.id,releaseId:manifest.release_id,sequence:manifest.sequence,rootHash,manifest:json(manifest),status:installed?'ACTIVE':'DISCOVERED'}});
  });
}

async function stagePart(lease:Lease,descriptor:SnapshotPartDescriptor,part:SnapshotPart,ordinal:number,releaseId:string){
  await prisma.$transaction(async tx=>{
    const session=await fenced(tx,lease);
    if(session.nextPart!==ordinal)throw new Error('snapshot_progress_conflict');
    const where={libraryId_sha256:{libraryId:lease.libraryId,sha256:descriptor.sha256}};
    const cached=await tx.inspirationSnapshotCatalogPart.findUnique({where});
    if(!cached){
      if(await occupiedBytes(tx,lease.libraryId)+descriptor.size>stagingLimit())throw new CapacityLimit();
      const ids=part.records.map(r=>r.case_id);
      const historical=await tx.$queryRaw<Array<{id:string;caseId:string;revision:number;contentHash:string;imageHash:string;deleted:boolean}>>`
        SELECT DISTINCT ON ("caseId") id,"caseId",revision,"contentHash","imageHash",deleted
        FROM "InspirationLibraryRecord" WHERE "libraryId"=${lease.libraryId} AND "caseId"=ANY(${ids}::text[]) ORDER BY "caseId",revision DESC`;
      const high=new Map<string,typeof historical[number]>();for(const row of historical)if(!high.has(row.caseId))high.set(row.caseId,row);
      const objects=new Map(part.objects.map(o=>[o.path,o]));
      const records:Prisma.InspirationRecordCreateManyInput[]=[];
      const entries:Prisma.InspirationSnapshotCatalogEntryCreateManyInput[]=[];
      for(const record of part.records){
        const imageHash=sha256(canonical(record.case!.images.map(i=>({path:i.path,sha256:objects.get(i.path)!.sha256})).sort((a,b)=>a.path.localeCompare(b.path))));
        const old=high.get(record.case_id);
        if(old&&(old.revision>record.revision||(old.revision===record.revision&&(old.contentHash!==record.content_hash||old.imageHash!==imageHash||old.deleted))))throw new Error('Case revision conflict');
        const recordId=old?.revision===record.revision?old.id:randomUUID();
        if(recordId!==old?.id)records.push({id:recordId,libraryId:lease.libraryId,caseId:record.case_id,revision:record.revision,contentHash:record.content_hash,imageHash,releaseId,deleted:false,body:json(record.case)});
        const projection=catalogMetadata(record.case!);
        entries.push({libraryId:lease.libraryId,partHash:descriptor.sha256,caseId:record.case_id,recordId,searchText:catalogSearchText(record.case!),contentType:projection.contentType,industry:projection.tags.industry??[],medium:projection.tags.medium??[],task:projection.tags.task??[]});
      }
      await tx.inspirationSnapshotCatalogPart.create({data:{libraryId:lease.libraryId,sha256:descriptor.sha256,prefix:descriptor.prefix,size:descriptor.size,recordCount:descriptor.records_count}});
      if(records.length)await tx.inspirationRecord.createMany({data:records});
      if(entries.length)await tx.inspirationSnapshotCatalogEntry.createMany({data:entries});
      if(part.objects.length)await tx.inspirationSnapshotPartObject.createMany({data:part.objects.map(o=>({...o,libraryId:lease.libraryId,partHash:descriptor.sha256}))});
    }else if(cached.size!==descriptor.size||cached.prefix!==descriptor.prefix||cached.recordCount!==descriptor.records_count)throw new Error('snapshot_part_identity_conflict');
    await tx.inspirationSnapshotImportPart.create({data:{importId:lease.id,ordinal,libraryId:lease.libraryId,partHash:descriptor.sha256}});
    await tx.inspirationSnapshotImport.update({where:{id:lease.id},data:{nextPart:ordinal+1,status:'VALIDATING'}});
  },{timeout:20000});
}

/** Aggregate metadata in SQL, never collect all image buffers or all part bodies. */
async function checkInventory(tx:Tx,sessionId:string,manifest:SnapshotManifest){
  const [counts]=await tx.$queryRaw<Array<{records:bigint;uniqueCases:bigint;images:bigint;imageBytes:bigint;missing:bigint;conflicts:bigint}>>`
    WITH parts AS (SELECT "libraryId","partHash" FROM "InspirationSnapshotImportPart" WHERE "importId"=${sessionId}),
    entries AS (SELECT e."caseId" FROM "InspirationSnapshotCatalogEntry" e JOIN parts p USING("libraryId","partHash")),
    objects AS (SELECT o.* FROM "InspirationSnapshotPartObject" o JOIN parts p USING("libraryId","partHash")),
    unique_objects AS (SELECT "libraryId","sha256",min(size) size,min(mime) mime,min(width) width,min(height) height,
      count(DISTINCT (size,mime,width,height)) variants FROM objects GROUP BY "libraryId","sha256")
    SELECT (SELECT count(*) FROM entries) records,(SELECT count(DISTINCT "caseId") FROM entries) "uniqueCases",
      count(*) images,coalesce(sum(o.size),0)::bigint "imageBytes",
      count(*) FILTER(WHERE c.sha256 IS NULL) missing,
      count(*) FILTER(WHERE o.variants<>1 OR (c.sha256 IS NOT NULL AND (c.size,c.mime,c.width,c.height) IS DISTINCT FROM (o.size,o.mime,o.width,o.height))) conflicts
    FROM unique_objects o LEFT JOIN "InspirationSnapshotObject" c USING("libraryId",sha256)`;
  if(!counts||Number(counts.records)!==manifest.records_count||counts.records!==counts.uniqueCases||Number(counts.images)!==manifest.image_count||Number(counts.imageBytes)!==manifest.image_bytes||counts.conflicts!==0n)throw new Error('snapshot_inventory_mismatch');
  return Number(counts.missing);
}

async function activate(library:LibraryScope,lease:Lease,manifest:SnapshotManifest,beforeActivate:(tx:Tx)=>Promise<void>){
  return prisma.$transaction(async tx=>{
    const session=await fenced(tx,lease);
    await beforeActivate(tx);
    const actual=await tx.inspirationLibrary.findUniqueOrThrow({where:{id:library.id}});
    if(actual.ownerId!==library.ownerId||actual.kind!==library.kind)throw new Error('snapshot_library_scope_changed');
    const origin=expected(library);if(manifest.recipient.library_id!==origin.library_id||manifest.recipient.origin!==origin.origin)throw new Error('snapshot_recipient_changed');
    const state=await tx.inspirationState.upsert({where:{libraryId:library.id},create:{libraryId:library.id},update:{}});
    if(session.nextPart!==manifest.parts.length||await checkInventory(tx,session.id,manifest)!==0)throw new Error('snapshot_incomplete');
    if(state.withdrawalSequence<manifest.withdrawal_sequence)throw new Error('snapshot_withdrawals_behind');
    if(manifest.sequence<=state.releaseSequence)throw new Error('Release rollback');
    const [revision]=await tx.$queryRaw<Array<{invalid:boolean}>>`SELECT EXISTS(
      SELECT 1 FROM "InspirationSnapshotImportPart" p
      JOIN "InspirationSnapshotCatalogEntry" e USING("libraryId","partHash")
      JOIN "InspirationLibraryRecord" r ON r.id=e."recordId"
      WHERE p."importId"=${session.id} AND EXISTS(SELECT 1 FROM "InspirationLibraryRecord" newer
        WHERE newer."libraryId"=r."libraryId" AND newer."caseId"=r."caseId" AND newer.revision>r.revision)) invalid`;
    if(revision?.invalid)throw new Error('Case revision conflict');
    // Reused immutable parts were authenticated for their original recipient.
    // Recheck stored grants when configuration/origin changes between releases.
    const [scope]=await tx.$queryRaw<Array<{invalid:boolean}>>`SELECT EXISTS(
      SELECT 1 FROM "InspirationSnapshotImportPart" p JOIN "InspirationSnapshotCatalogEntry" e USING("libraryId","partHash")
      JOIN "InspirationLibraryRecord" r ON r.id=e."recordId" WHERE p."importId"=${session.id} AND (
        r.body #>> '{editorial,publication_use_basis,recipient,origin}' IS DISTINCT FROM ${origin.origin}
        OR r.body #>> '{editorial,publication_use_basis,recipient,library_id}' IS DISTINCT FROM ${library.id}
        OR r.body #>> '{editorial,publication_use_basis,recipient,kind}' IS DISTINCT FROM 'library'
        OR r.body->>'display_permission' IS DISTINCT FROM 'allowed')) invalid`;
    if(scope?.invalid)throw new Error('snapshot_recipient_changed');
    // The ledger sees only visible, currently unwithdrawn objects, never staging CAS.
    const hashes=await tx.$queryRaw<Array<{sha256:string}>>`
      SELECT DISTINCT o.sha256 FROM "InspirationSnapshotImportPart" p
      JOIN "InspirationSnapshotCatalogEntry" e USING("libraryId","partHash")
      JOIN "InspirationLibraryRecord" r ON r.id=e."recordId"
      CROSS JOIN LATERAL jsonb_array_elements(r.body->'images') img
      JOIN "InspirationSnapshotPartObject" o ON o."libraryId"=e."libraryId" AND o."partHash"=e."partHash" AND o.path=img->>'path'
      WHERE p."importId"=${session.id} AND r.body->>'display_permission'='allowed'
        AND NOT (${JSON.stringify(state.withdrawn)}::jsonb ? e."caseId")`;
    if(!dailyReceiptsEnabled(library.ownerId))throw new Error('snapshot_daily_receipts_required');
    const policy=await beginDailyReceipt(tx,library.ownerId);
    await recordSnapshotDailyReceipt(tx,{ownerId:library.ownerId,libraryId:library.id,releaseId:manifest.release_id,hashes:hashes.map(r=>r.sha256),target:policy.target});
    // Permission/lease changes during metadata and ledger work roll back all
    // writes, including receipts. No slow I/O is permitted in this callback.
    await fenced(tx,lease);await beforeActivate(tx);
    await tx.inspirationRelease.create({data:{libraryId:library.id,releaseId:manifest.release_id,sequence:manifest.sequence,manifestHash:session.rootHash,manifest:json(manifest),snapshot:{snapshot_version:3}}});
    await tx.$executeRaw`INSERT INTO "InspirationSnapshotReleasePart" ("libraryId","releaseId",ordinal,"partHash")
      SELECT "libraryId",${manifest.release_id},ordinal,"partHash" FROM "InspirationSnapshotImportPart" WHERE "importId"=${session.id}`;
    await tx.inspirationState.update({where:{libraryId:library.id},data:{activeRelease:manifest.release_id,releaseSequence:manifest.sequence,lastSyncAt:new Date(),syncError:null,lastError:null}});
    await tx.inspirationSnapshotImport.update({where:{id:session.id},data:{status:'ACTIVE',leaseOwner:null,leaseUntil:null,lastError:null}});
    return 'ACTIVE';
  },{timeout:20000,maxWait:5000});
}

export type SnapshotTickOptions={sessionId:string;workerId:string;fetchPart:(hash:string,maxBytes:number)=>Promise<Buffer>;fetchObject:(hash:string,maxBytes:number)=>Promise<Buffer>;beforeActivate:(tx:Tx)=>Promise<void>;signal?:AbortSignal;maxBytes?:number;maxObjects?:number;maxMs?:number};
export async function syncSnapshotTick(library:LibraryScope,options:SnapshotTickOptions){
  enabled();const maxBytes=bound(options.maxBytes,256*MiB,256*MiB),maxObjects=bound(options.maxObjects,8,64),maxMs=bound(options.maxMs,20000,30000),started=Date.now();
  const claimed=await prisma.$transaction(async tx=>{
    await lock(tx,library.id);
    const row=await tx.inspirationSnapshotImport.findUniqueOrThrow({where:{id:options.sessionId}});
    if(row.libraryId!==library.id)throw new Error('snapshot_import_scope_mismatch');
    if(['ACTIVE','CANCELLED','FAILED_VALIDATION'].includes(row.status))return row;
    if(row.leaseUntil&&row.leaseUntil.getTime()>Date.now())throw new SnapshotLeaseLost();
    return tx.inspirationSnapshotImport.update({where:{id:row.id},data:{leaseOwner:options.workerId,leaseEpoch:{increment:1},leaseUntil:new Date(Date.now()+90000),status:row.nextPart===0?'VALIDATING':'DOWNLOADING',lastError:null}});
  });
  let bytes=0,objects=0;
  const result=(status:string)=>({sessionId:claimed.id,status,complete:status==='ACTIVE',bytes,objects});
  if(['ACTIVE','CANCELLED','FAILED_VALIDATION'].includes(claimed.status))return result(claimed.status);
  const lease:Lease={id:claimed.id,libraryId:library.id,workerId:options.workerId,epoch:claimed.leaseEpoch},manifest=claimed.manifest as unknown as SnapshotManifest;
  const canTake=(size:number)=>objects<maxObjects&&bytes+size<=maxBytes&&Date.now()-started<maxMs;
  try{
    for(let ordinal=claimed.nextPart;ordinal<manifest.parts.length;ordinal++){
      options.signal?.throwIfAborted();const descriptor=manifest.parts[ordinal]!;if(!canTake(descriptor.size))break;
      const cached=await prisma.inspirationSnapshotCatalogPart.findUnique({where:{libraryId_sha256:{libraryId:library.id,sha256:descriptor.sha256}}});
      // Reused immutable parts need no network or body re-materialization.
      if(cached){
        await prisma.$transaction(async tx=>{const session=await fenced(tx,lease);if(session.nextPart!==ordinal)throw new Error('snapshot_progress_conflict');
          if(cached.prefix!==descriptor.prefix||cached.size!==descriptor.size||cached.recordCount!==descriptor.records_count)throw new Error('snapshot_part_identity_conflict');
          await tx.inspirationSnapshotImportPart.create({data:{importId:lease.id,ordinal,libraryId:library.id,partHash:descriptor.sha256}});
          await tx.inspirationSnapshotImport.update({where:{id:lease.id},data:{nextPart:ordinal+1}});});objects++;continue;
      }
      const raw=await options.fetchPart(descriptor.sha256,descriptor.size);bytes+=raw.length;objects++;
      let part:SnapshotPart;try{part=validateSnapshotPart(raw,descriptor,manifest);}catch{throw new InvalidSnapshot();}
      await stagePart(lease,descriptor,part,ordinal,manifest.release_id);
    }
    let current=await prisma.inspirationSnapshotImport.findUniqueOrThrow({where:{id:lease.id}});
    if(current.nextPart===manifest.parts.length){
      await prisma.$transaction(async tx=>{await fenced(tx,lease);await checkInventory(tx,lease.id,manifest);});
      while(objects<maxObjects&&Date.now()-started<maxMs){
        options.signal?.throwIfAborted();
        const [object]=await prisma.$queryRaw<SnapshotObjectDescriptor[]>`SELECT DISTINCT o.path,o.sha256,o.size,o.mime,o.width,o.height
          FROM "InspirationSnapshotImportPart" p JOIN "InspirationSnapshotPartObject" o USING("libraryId","partHash")
          LEFT JOIN "InspirationSnapshotObject" c ON c."libraryId"=o."libraryId" AND c.sha256=o.sha256
          WHERE p."importId"=${lease.id} AND c.sha256 IS NULL ORDER BY o.sha256 LIMIT 1`;
        if(!object||!canTake(object.size))break;
        if(await occupiedBytes(prisma,library.id)+object.size>stagingLimit())throw new CapacityLimit();
        const raw=await options.fetchObject(object.sha256,object.size);bytes+=raw.length;objects++;
        try{await validateSnapshotObject(raw,object);}catch{throw new InvalidSnapshot();}options.signal?.throwIfAborted();
        await prisma.$transaction(async tx=>{await fenced(tx,lease);
          const occupied=await occupiedBytes(tx,library.id);
          const existing=await tx.inspirationSnapshotObject.findUnique({where:{libraryId_sha256:{libraryId:library.id,sha256:object.sha256}},select:{sha256:true}});
          if(!existing){if(occupied+object.size>stagingLimit())throw new CapacityLimit();
            const {path:_,...meta}=object;await tx.inspirationSnapshotObject.create({data:{...meta,libraryId:library.id,bytes:new Uint8Array(raw)}});}
        });
      }
      const missing=await prisma.$transaction(async tx=>{await fenced(tx,lease);return checkInventory(tx,lease.id,manifest);});
      if(missing===0){options.signal?.throwIfAborted();return result(await activate(library,lease,manifest,options.beforeActivate));}
    }
    current=await prisma.inspirationSnapshotImport.findUniqueOrThrow({where:{id:lease.id}});
    const status=current.nextPart===manifest.parts.length?'DOWNLOADING':'VALIDATING';
    await prisma.$transaction(async tx=>{await fenced(tx,lease);await tx.inspirationSnapshotImport.update({where:{id:lease.id},data:{status,leaseOwner:null,leaseUntil:null}});});
    return result(status);
  }catch(error){
    if(error instanceof SnapshotLeaseLost)throw error;
    const permanent=error instanceof InvalidSnapshot||(error instanceof Error&&['snapshot_inventory_mismatch','snapshot_part_identity_conflict','snapshot_recipient_changed','snapshot_library_scope_changed','Case revision conflict','Release rollback','snapshot_progress_conflict'].includes(error.message));
    const status=error instanceof CapacityLimit?'WAITING_CAPACITY':error instanceof DailyReceiptLimit?'WAITING_DAILY_QUOTA':permanent?'FAILED_VALIDATION':'DOWNLOADING';
    // Operational/network interruption is resumable. No error body or remote URL is persisted.
    await prisma.$transaction(async tx=>{await fenced(tx,lease);await tx.inspirationSnapshotImport.update({where:{id:lease.id},data:{status,lastError:error instanceof CapacityLimit?'capacity':error instanceof DailyReceiptLimit?'daily_quota':permanent?'validation_failed':'interrupted',leaseOwner:null,leaseUntil:null}});});
    if(error instanceof CapacityLimit||error instanceof DailyReceiptLimit)return result(status);throw error;
  }
}

export async function readSnapshotCatalog(libraryId:string,releaseId:string,options:{caseIds?:string[];afterCaseId?:string;take?:number;excludedCaseIds?:string[]}={}){
  const take=bound(options.take,500,100000);
  return prisma.inspirationRecord.findMany({where:{libraryId,deleted:false,
    ...(options.caseIds?{caseId:{in:options.caseIds,...(options.afterCaseId?{gt:options.afterCaseId}:{})}}:options.afterCaseId?{caseId:{gt:options.afterCaseId}}:{}),
    ...(options.excludedCaseIds?.length?{NOT:{caseId:{in:options.excludedCaseIds}}}:{}),
    catalogEntries:{some:{part:{releases:{some:{libraryId,releaseId}}}}}},orderBy:{caseId:'asc'},take});
}
export async function getSnapshotCatalogCount(libraryId:string,releaseId:string,options:{excludedCaseIds?:string[]}={}){
  return prisma.inspirationSnapshotCatalogEntry.count({where:{libraryId,...(options.excludedCaseIds?.length?{caseId:{notIn:options.excludedCaseIds}}:{}),part:{releases:{some:{libraryId,releaseId}}}}});
}
export async function getSnapshotObject(libraryId:string,releaseId:string,path:string){
  const descriptor=await prisma.inspirationSnapshotPartObject.findFirst({where:{libraryId,path,part:{releases:{some:{libraryId,releaseId}}}}});
  return descriptor?prisma.inspirationSnapshotObject.findUnique({where:{libraryId_sha256:{libraryId,sha256:descriptor.sha256}}}):null;
}

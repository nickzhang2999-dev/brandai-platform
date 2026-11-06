import { randomUUID } from 'node:crypto';
import { beforeAll,beforeEach,afterAll,afterEach,describe,it,expect,vi } from 'vitest';
import { prisma } from '@brandai/db';
import sharp from 'sharp';
import type { LibraryScope } from '../src/lib/inspiration/library-scope';
import { createSnapshotImport,syncSnapshotTick,readSnapshotCatalog,getSnapshotCatalogCount,getSnapshotObject,SnapshotLeaseLost } from '../src/lib/inspiration/snapshot-import';
import { chinaDay,initializeDailyPolicy } from '../src/lib/inspiration/daily-receipts';
import { canonical,sha256 } from '../src/lib/inspiration/protocol';
import { activeRecords } from '../src/lib/inspiration/replica';
import { snapshotCatalogPage } from '../src/lib/inspiration/snapshot-catalog';
import { readInspirationImage } from '../src/lib/inspiration/image-store';
import { bytes,fixture,keys,recipient,signed,replaceParts } from './helpers/inspiration-snapshot-fixture';

const isolated=process.env.INSPIRATION_SNAPSHOT_TEST_DATABASE_URL;
const suite=isolated?describe:describe.skip;
suite('snapshot v3 isolated PostgreSQL persistence',()=>{
  const owner='snapshot-owner-'+randomUUID();
  const library:LibraryScope={id:recipient.library_id,kind:'SHARED',ownerId:owner,legacyWorkspaceId:null};
  const libraryIds=[library.id];
  async function cleanup(){
    await prisma.inspirationSnapshotReleasePart.deleteMany({where:{libraryId:{in:libraryIds}}});
    await prisma.inspirationSnapshotImport.deleteMany({where:{libraryId:{in:libraryIds}}});
    await prisma.inspirationSnapshotCatalogPart.deleteMany({where:{libraryId:{in:libraryIds}}});
    await prisma.inspirationImageReceipt.deleteMany({where:{ownerId:owner}});
    await prisma.inspirationDailyPolicy.deleteMany({where:{ownerId:owner}});
    await prisma.inspirationLibrary.deleteMany({where:{id:{in:libraryIds}}});
  }
  beforeAll(async()=>{
    const url=new URL(isolated!);
    if(url.hostname!=='127.0.0.1'||url.port!=='55525'||url.pathname!=='/nova_snapshot_20261106_test'||process.env.DATABASE_URL!==isolated)throw new Error('Dedicated local snapshot PostgreSQL required');
    if(await prisma.inspirationLibrary.findUnique({where:{id:library.id}}))throw new Error('Synthetic library already exists; refusing to reuse');
    await prisma.user.create({data:{id:owner,email:owner+'@example.invalid',isActive:true}});
  });
  beforeEach(async()=>{
    vi.stubEnv('INSPIRATION_SNAPSHOT_V3_ENABLED','true');vi.stubEnv('INSPIRATION_RECEIVER_ORIGIN',recipient.origin);
    vi.stubEnv('INSPIRATION_DAILY_RECEIPTS_ENABLED','true');vi.stubEnv('INSPIRATION_RECEIPT_OWNER_ID',owner);vi.stubEnv('INSPIRATION_SNAPSHOT_BOOTSTRAP','');
    vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No network allowed');}));
    await prisma.inspirationLibrary.create({data:{id:library.id,ownerId:owner,kind:'SHARED'}});
    await initializeDailyPolicy(owner);
  });
  afterEach(async()=>{await cleanup();vi.unstubAllEnvs();vi.unstubAllGlobals();});
  afterAll(async()=>{await prisma.user.deleteMany({where:{id:owner}});await prisma.$disconnect();});
  async function setup(count=2){
    const f=await fixture(count),session=await createSnapshotImport(library,bytes(f.manifest),keys);
    const fetchPart=vi.fn(async(hash:string)=>bytes(f.parts[f.manifest.parts.findIndex(p=>p.sha256===hash)]!));
    const fetchObject=vi.fn(async()=>f.image);
    const beforeActivate=vi.fn(async(tx:Parameters<Parameters<typeof syncSnapshotTick>[1]['beforeActivate']>[0])=>{
      if(!(await tx.user.findUniqueOrThrow({where:{id:owner}})).isActive)throw new Error('receiver_disabled');
    });
    const options={sessionId:session.id,workerId:'synthetic-worker',fetchPart,fetchObject,beforeActivate};
    return {...f,session,options};
  }
  it('pins a root, persists partial progress, resumes and atomically exposes one complete catalog',async()=>{
    const f=await setup();const first=await syncSnapshotTick(library,{...f.options,maxObjects:1});
    expect(first.complete).toBe(false);expect(await prisma.inspirationRelease.count({where:{libraryId:library.id}})).toBe(0);
    expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner}})).toBe(0);
    expect((await createSnapshotImport(library,bytes(f.manifest),keys)).id).toBe(f.session.id);
    const done=await syncSnapshotTick(library,{...f.options,workerId:'after-restart',maxObjects:64});expect(done.status).toBe('ACTIVE');
    expect(f.options.fetchPart).toHaveBeenCalledTimes(f.parts.length);expect(f.options.fetchObject).toHaveBeenCalledTimes(1);
    expect(await getSnapshotCatalogCount(library.id,f.manifest.release_id)).toBe(2);
    expect((await readSnapshotCatalog(library.id,f.manifest.release_id)).map(r=>r.caseId)).toEqual(['synthetic-000000','synthetic-000001']);
    expect(Buffer.from((await getSnapshotObject(library.id,f.manifest.release_id,f.object.path))!.bytes)).toEqual(f.image);
    expect(await getSnapshotObject(library.id,'unknown-release',f.object.path)).toBeNull();
    expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner,receivedDay:chinaDay()}})).toBe(1);
  });
  it('reuses immutable catalog parts and CAS across a newer snapshot with no download or duplicate receipt',async()=>{
    const f=await setup();await syncSnapshotTick(library,f.options);
    const next=signed({...f.manifest,release_id:'next',sequence:2}),session=await createSnapshotImport(library,bytes(next),keys);
    f.options.fetchPart.mockClear();f.options.fetchObject.mockClear();
    expect((await syncSnapshotTick(library,{...f.options,sessionId:session.id})).complete).toBe(true);
    expect(f.options.fetchPart).not.toHaveBeenCalled();expect(f.options.fetchObject).not.toHaveBeenCalled();
    expect(await prisma.inspirationSnapshotCatalogPart.count({where:{libraryId:library.id}})).toBe(f.parts.length);
    expect(await prisma.inspirationSnapshotObject.count({where:{libraryId:library.id}})).toBe(1);
    expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner}})).toBe(1);
    const active=await activeRecords(library,{caseIds:['synthetic-000000']});
    expect(active.records[0]!.releaseId).toBe(f.manifest.release_id);expect(active.release!.releaseId).toBe('next');
    const served=await readInspirationImage(active.records[0]!,f.object.path,active.release!.releaseId,true);
    expect(Buffer.from(served!.bytes)).toEqual(f.image);
  });
  it('rejects immutable root conflicts without altering the pinned root',async()=>{
    const f=await setup();await expect(createSnapshotImport(library,bytes(signed({...f.manifest,request_hash:'d'.repeat(64)})),keys)).rejects.toThrow('root_conflict');
    expect((await prisma.inspirationSnapshotImport.findUniqueOrThrow({where:{id:f.session.id}})).rootHash).toBe(f.session.rootHash);
  });
  it('rejects cached case grants bound to a different receiver origin',async()=>{
    const f=await setup(1);await syncSnapshotTick(library,f.options);const changed='https://changed.example.invalid';
    vi.stubEnv('INSPIRATION_RECEIVER_ORIGIN',changed);
    const next=signed({...f.manifest,release_id:'scope-changed',sequence:2,recipient:{...recipient,origin:changed}}),session=await createSnapshotImport(library,bytes(next),keys);
    await expect(syncSnapshotTick(library,{...f.options,sessionId:session.id})).rejects.toThrow('snapshot_recipient_changed');
    expect((await prisma.inspirationState.findUniqueOrThrow({where:{libraryId:library.id}})).activeRelease).toBe(f.manifest.release_id);
  });
  it('resumes a network interruption but terminates deterministic image corruption',async()=>{
    const f=await setup();f.options.fetchPart.mockRejectedValueOnce(new Error('synthetic interruption'));
    await expect(syncSnapshotTick(library,f.options)).rejects.toThrow('synthetic interruption');
    expect((await prisma.inspirationSnapshotImport.findUniqueOrThrow({where:{id:f.session.id}})).status).toBe('DOWNLOADING');
    f.options.fetchObject.mockResolvedValue(Buffer.from('invalid image'));
    await expect(syncSnapshotTick(library,f.options)).rejects.toThrow('snapshot_validation_failed');
    const calls=f.options.fetchObject.mock.calls.length;expect((await syncSnapshotTick(library,f.options)).status).toBe('FAILED_VALIDATION');
    expect(f.options.fetchObject.mock.calls.length).toBe(calls);expect(await prisma.inspirationRelease.count({where:{libraryId:library.id}})).toBe(0);
  });
  it('leaves verified CAS staged on permission change and writes no active release or receipt',async()=>{
    const f=await setup();await prisma.user.update({where:{id:owner},data:{isActive:false}});
    await expect(syncSnapshotTick(library,f.options)).rejects.toThrow('receiver_disabled');
    expect(await prisma.inspirationRelease.count({where:{libraryId:library.id}})).toBe(0);expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner}})).toBe(0);
    expect(await prisma.inspirationSnapshotObject.count({where:{libraryId:library.id}})).toBe(1);
    await prisma.user.update({where:{id:owner},data:{isActive:true}});
    expect((await syncSnapshotTick(library,f.options)).complete).toBe(true);expect(f.options.fetchObject).toHaveBeenCalledTimes(1);
  });
  it('waits for daily quota without treating pending CAS as baseline and resumes next allowance',async()=>{
    const f=await setup();await prisma.inspirationImageReceipt.createMany({data:Array.from({length:100},(_,i)=>({ownerId:owner,sha256:i.toString(16).padStart(64,'0'),receivedDay:chinaDay(),receivedAt:new Date()}))});
    expect((await syncSnapshotTick(library,f.options)).status).toBe('WAITING_DAILY_QUOTA');
    expect(await prisma.inspirationImageReceipt.findUnique({where:{ownerId_sha256:{ownerId:owner,sha256:f.object.sha256}}})).toBeNull();
    expect(await prisma.inspirationRelease.count({where:{libraryId:library.id}})).toBe(0);
    await prisma.inspirationImageReceipt.delete({where:{ownerId_sha256:{ownerId:owner,sha256:'0'.repeat(64)}}});
    expect((await syncSnapshotTick(library,f.options)).complete).toBe(true);expect(f.options.fetchObject).toHaveBeenCalledTimes(1);
  });
  it('waits on a finite capacity bound before fetching bytes and resumes when explicitly changed',async()=>{
    const f=await setup();vi.stubEnv('INSPIRATION_SNAPSHOT_STAGING_BYTES','1');
    expect((await syncSnapshotTick(library,f.options)).status).toBe('WAITING_CAPACITY');expect(f.options.fetchObject).not.toHaveBeenCalled();
    vi.stubEnv('INSPIRATION_SNAPSHOT_STAGING_BYTES','1048576');expect((await syncSnapshotTick(library,f.options)).complete).toBe(true);
  });
  it('rechecks withdrawals committed during download before counting visible images',async()=>{
    const f=await setup(1);f.options.fetchObject.mockImplementationOnce(async()=>{
      await prisma.inspirationState.upsert({where:{libraryId:library.id},create:{libraryId:library.id,withdrawalSequence:1,withdrawn:['synthetic-000000']},update:{withdrawalSequence:1,withdrawn:['synthetic-000000']}});return f.image;
    });
    expect((await syncSnapshotTick(library,f.options)).complete).toBe(true);
    expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner}})).toBe(0);
    expect(await getSnapshotCatalogCount(library.id,f.manifest.release_id,{excludedCaseIds:['synthetic-000000']})).toBe(0);
  });
  it('fences an expired worker after another worker resumes the same root',async()=>{
    const f=await setup(1);let release!:(raw:Buffer)=>void;let entered!:()=>void;
    const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});
    const old=syncSnapshotTick(library,{...f.options,workerId:'expired',fetchPart:async()=>{entered();return new Promise<Buffer>(resolve=>{release=resolve;});}});
    await enteredPromise;await prisma.inspirationSnapshotImport.update({where:{id:f.session.id},data:{leaseUntil:new Date(0)}});
    expect((await syncSnapshotTick(library,{...f.options,workerId:'replacement'})).complete).toBe(true);
    release(bytes(f.parts[0]));await expect(old).rejects.toBeInstanceOf(SnapshotLeaseLost);
    expect((await prisma.inspirationSnapshotImport.findUniqueOrThrow({where:{id:f.session.id}})).status).toBe('ACTIVE');
    expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner}})).toBe(1);
  });
  it('atomically preserves the old active pointer when a later activation loses authorization',async()=>{
    const f=await setup(1);await syncSnapshotTick(library,f.options);
    const next=signed({...f.manifest,release_id:'next-denied',sequence:2}),session=await createSnapshotImport(library,bytes(next),keys);
    await expect(syncSnapshotTick(library,{...f.options,sessionId:session.id,beforeActivate:async()=>{throw new Error('permission_changed');}})).rejects.toThrow('permission_changed');
    expect((await prisma.inspirationState.findUniqueOrThrow({where:{libraryId:library.id}})).activeRelease).toBe(f.manifest.release_id);
    expect(await prisma.inspirationRelease.count({where:{libraryId:library.id}})).toBe(1);expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner}})).toBe(1);
  });
  it('rolls back receipt writes when the final authorization recheck fails',async()=>{
    const f=await setup(1);let checks=0;
    await expect(syncSnapshotTick(library,{...f.options,beforeActivate:async()=>{if(++checks===2)throw new Error('final_permission_changed');}})).rejects.toThrow('final_permission_changed');
    expect(checks).toBe(2);expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner}})).toBe(0);
    expect(await prisma.inspirationRelease.count({where:{libraryId:library.id}})).toBe(0);
    expect(await prisma.inspirationSnapshotObject.count({where:{libraryId:library.id}})).toBe(1);
  });
  it('keeps revision high water even after a case disappears from a complete snapshot',async()=>{
    const f=await setup(1);await syncSnapshotTick(library,f.options);
    const upgraded=structuredClone(f.parts);const record=upgraded[0]!.records[0]!;record.revision=2;record.case.revision=2;
    (record.case.editorial as {publication_use_basis:{revision:number}}).publication_use_basis.revision=2;record.content_hash=sha256(canonical(record.case));
    const second=replaceParts(signed({...f.manifest,release_id:'revision-two',sequence:2}),upgraded),session=await createSnapshotImport(library,bytes(second),keys);
    await syncSnapshotTick(library,{...f.options,sessionId:session.id,fetchPart:async()=>bytes(upgraded[0])});
    const empty=await fixture(0),third=signed({...empty.manifest,release_id:'empty',sequence:3}),blank=await createSnapshotImport(library,bytes(third),keys);
    expect((await syncSnapshotTick(library,{...f.options,sessionId:blank.id})).complete).toBe(true);
    const obsolete=signed({...f.manifest,release_id:'obsolete',sequence:4}),bad=await createSnapshotImport(library,bytes(obsolete),keys);
    await expect(syncSnapshotTick(library,{...f.options,sessionId:bad.id})).rejects.toThrow('Case revision conflict');
    expect((await prisma.inspirationState.findUniqueOrThrow({where:{libraryId:library.id}})).activeRelease).toBe('empty');
    expect((await prisma.inspirationSnapshotImport.findUniqueOrThrow({where:{id:bad.id}})).status).toBe('FAILED_VALIDATION');
  });
  it('deduplicates one image receipt during concurrent activation in two owner libraries',async()=>{
    const a=await setup(1),b={...library,id:'synthetic-second-library'};libraryIds.push(b.id);
    await prisma.inspirationLibrary.create({data:{id:b.id,kind:'SHARED',ownerId:owner}});
    const parts=structuredClone(a.parts);for(const part of parts)for(const record of part.records){
      (record.case.editorial as {publication_use_basis:{recipient:{library_id:string}}}).publication_use_basis.recipient.library_id=b.id;record.content_hash=sha256(canonical(record.case));
    }
    const root=replaceParts(signed({...a.manifest,recipient:{...recipient,library_id:b.id}}),parts),session=await createSnapshotImport(b,bytes(root),keys);
    const results=await Promise.all([syncSnapshotTick(library,a.options),syncSnapshotTick(b,{...a.options,sessionId:session.id,fetchPart:async()=>bytes(parts[0])})]);
    expect(results.every(r=>r.complete)).toBe(true);expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner}})).toBe(1);
    expect(await prisma.inspirationSnapshotObject.count({where:{libraryId:{in:[library.id,b.id]}}})).toBe(2);
  });
  it('allows existing library cascade deletion without leaving partial foreign-key state',async()=>{
    const f=await setup(1);await syncSnapshotTick(library,f.options);
    await prisma.inspirationLibrary.delete({where:{id:library.id}});
    expect(await prisma.inspirationSnapshotCatalogEntry.count({where:{libraryId:library.id}})).toBe(0);
    expect(await prisma.inspirationSnapshotObject.count({where:{libraryId:library.id}})).toBe(0);
    expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner}})).toBe(1);
  });
  it('filters case, source and image analysis permission before the 96-result retrieval limit',async()=>{
    const f=await fixture(100);
    for(const part of f.parts)for(const record of part.records){
      const index=Number(record.case_id.slice(-6));
      record.case.permissions={analysis:index<95?'denied':'allowed',display:'allowed'};
      record.case.sources[0]!.permissions={analysis:index===96?'denied':'allowed',display:'allowed'};
      record.case.images[0]!.permissions={analysis:index===95?'denied':'allowed',display:'allowed'};
      record.content_hash=sha256(canonical(record.case));
    }
    const manifest=replaceParts(f.manifest,f.parts),session=await createSnapshotImport(library,bytes(manifest),keys);
    let done=false;for(let tick=0;tick<5&&!done;tick++)done=(await syncSnapshotTick(library,{sessionId:session.id,workerId:'analysis-permission-test',maxObjects:64,
      fetchPart:async hash=>bytes(f.parts[manifest.parts.findIndex(p=>p.sha256===hash)]!),fetchObject:async()=>f.image,beforeActivate:async()=>{}})).complete;
    expect(done).toBe(true);
    const page=await snapshotCatalogPage(library.id,manifest.release_id,{q:'合成'},{limit:96},{analysisOnly:true});
    expect(page.records.map(r=>r.caseId)).toEqual(['synthetic-000097','synthetic-000098','synthetic-000099']);expect(page.matchedCount).toBe(3);
    await prisma.inspirationState.update({where:{libraryId:library.id},data:{withdrawn:['synthetic-000098'],withdrawalSequence:1}});
    const withdrawn=await snapshotCatalogPage(library.id,manifest.release_id,{q:'合成'},{limit:96},{analysisOnly:true});
    expect(withdrawn.caseCount).toBe(2);expect(withdrawn.matchedCount).toBe(2);expect(withdrawn.records.map(r=>r.caseId)).toEqual(['synthetic-000097','synthetic-000099']);
  });
  it('separately accounts for explicitly scoped 501-image initialization and rejects sequence rollback',async()=>{
    const f=await fixture(501),images=new Map<string,Buffer>();let color=0;
    for(const part of f.parts){part.objects=[];for(const record of part.records){
      const image=await sharp({create:{width:3,height:2,channels:3,background:{r:color%256,g:Math.floor(color/256),b:77}}}).png().toBuffer();color++;
      const hash=sha256(image),path=`images/${hash}.png`;images.set(hash,image);
      record.case.images[0]!.path=path;(record.case.editorial as {publication_use_basis:{sha256:string}}).publication_use_basis.sha256=hash;
      record.content_hash=sha256(canonical(record.case));part.objects.push({path,sha256:hash,size:image.length,mime:'image/png',width:3,height:2});
    }part.objects.sort((a,b)=>a.path<b.path?-1:1);}
    const manifest=replaceParts(signed({...f.manifest,image_count:images.size,image_bytes:[...images.values()].reduce((n,b)=>n+b.length,0)}),f.parts);
    const session=await createSnapshotImport(library,bytes(manifest),keys);
    await prisma.inspirationDailyPolicy.update({where:{ownerId:owner},data:{target:500}});
    const options={sessionId:session.id,workerId:'bootstrap-synthetic',maxObjects:64,fetchPart:async(hash:string)=>bytes(f.parts[manifest.parts.findIndex(p=>p.sha256===hash)]!),fetchObject:async(hash:string)=>images.get(hash)!,beforeActivate:async()=>{}};
    let status='';for(let tick=0;tick<20&&!status.startsWith('WAITING');tick++)status=(await syncSnapshotTick(library,options)).status;
    expect(status).toBe('WAITING_DAILY_QUOTA');expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner}})).toBe(0);
    vi.stubEnv('INSPIRATION_SNAPSHOT_BOOTSTRAP',JSON.stringify({ownerId:owner,libraryId:library.id,releaseId:'wrong-root',maxImages:501}));
    expect((await syncSnapshotTick(library,options)).status).toBe('WAITING_DAILY_QUOTA');
    vi.stubEnv('INSPIRATION_SNAPSHOT_BOOTSTRAP',JSON.stringify({ownerId:owner,libraryId:library.id,releaseId:manifest.release_id,maxImages:501}));
    expect((await syncSnapshotTick(library,options)).complete).toBe(true);
    expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner,initializationId:{not:null}}})).toBe(501);
    expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner,receivedDay:chinaDay()}})).toBe(0);
    expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner,receivedDay:null,initializationId:null}})).toBe(0);
    await expect(createSnapshotImport(library,bytes(signed({...manifest,release_id:'rollback',sequence:1})),keys)).rejects.toThrow('Release rollback');
    expect((await syncSnapshotTick(library,options)).complete).toBe(true);expect(await prisma.inspirationImageReceipt.count({where:{ownerId:owner}})).toBe(501);
  },60000);
  it.each([2001,10000])('persists a %i-case snapshot in bounded ticks and queries a small page',async count=>{
    const f=await setup(count);let done=false,ticks=0;
    while(!done&&ticks<10){const result=await syncSnapshotTick(library,{...f.options,maxObjects:64});expect(result.objects).toBeLessThanOrEqual(64);expect(result.bytes).toBeLessThanOrEqual(256*1024*1024);done=result.complete;ticks++;}
    expect(done).toBe(true);expect(ticks).toBeGreaterThan(1);expect(await getSnapshotCatalogCount(library.id,f.manifest.release_id)).toBe(count);
    expect(await readSnapshotCatalog(library.id,f.manifest.release_id,{take:5})).toHaveLength(5);expect(f.options.fetchObject).toHaveBeenCalledTimes(1);
    if(count===2001){
      const seen=new Set<string>();let cursor:string|null=null;
      do{const page=await snapshotCatalogPage(library.id,f.manifest.release_id,{q:'合成',medium:'poster'},{limit:200,cursor});
        expect(page.matchedCount).toBe(count);for(const row of page.records){expect(seen.has(row.caseId)).toBe(false);seen.add(row.caseId);}cursor=page.nextCursor;
      }while(cursor);
      expect(seen.size).toBe(count);expect((await snapshotCatalogPage(library.id,f.manifest.release_id,{q:'absent-token'})).records).toHaveLength(0);
      expect((await snapshotCatalogPage(library.id,f.manifest.release_id,{medium:'packaging'})).records).toHaveLength(0);
      expect((await activeRecords(library,{caseIds:['synthetic-002000']})).records).toHaveLength(1);
      await prisma.inspirationState.update({where:{libraryId:library.id},data:{withdrawn:['synthetic-002000'],withdrawalSequence:1}});
      expect((await activeRecords(library,{caseIds:['synthetic-002000']})).records).toHaveLength(0);
      const filtered=await snapshotCatalogPage(library.id,f.manifest.release_id,{medium:'poster'});expect(filtered.caseCount).toBe(count-1);expect(filtered.matchedCount).toBe(count-1);
    }
  },60000);
});

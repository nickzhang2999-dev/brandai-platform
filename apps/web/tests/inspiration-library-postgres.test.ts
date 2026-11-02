import { randomUUID,generateKeyPairSync,sign } from 'node:crypto';
import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import sharp from 'sharp';
const auth=vi.hoisted(()=>({user:{id:'',email:''},adminId:''}));
vi.mock('@/lib/api',()=>({ApiException:class extends Error{constructor(public status:number,message:string){super(message);}},requireUser:async()=>auth.user,parse:(schema:{parse:(v:unknown)=>unknown},value:unknown)=>schema.parse(value),ok:(value:unknown,init?:ResponseInit)=>Response.json(value,init),handleError:(error:{status?:number;message:string})=>Response.json({error:error.message},{status:error.status??500})}));
vi.mock('@/lib/admin',()=>({requireAdmin:async()=>{if(auth.user.id!==auth.adminId)throw Object.assign(new Error('admin only'),{status:403});return auth.user;},isAdminUser:async(id:string)=>id===auth.adminId}));
import { prisma } from '@brandai/db';
import { resolveLibrary } from '../src/lib/inspiration/library';
import type { LibraryScope } from '../src/lib/inspiration/library-scope';
import { canonical,sha256,type PublishedCase } from '../src/lib/inspiration/protocol';
import { activeRecords,applyWithdrawal,installPackage,syncReplica } from '../src/lib/inspiration/replica';
import { createChat,getChat,listCases } from '../src/lib/inspiration/service';
import { requireLibraryReceiver } from '../src/lib/inspiration/access';
import { POST as initialize } from '../src/app/api/admin/inspiration/libraries/route';
import { GET as receiveStatus,POST as receive } from '../src/app/api/workspaces/[wsId]/inspiration/sync/route';
import { GET as imageRoute } from '../src/app/api/workspaces/[wsId]/inspiration/cases/[caseId]/images/[imageId]/route';
import { GET as bookmarks,POST as bookmark } from '../src/app/api/workspaces/[wsId]/inspiration/bookmarks/route';

const isolated=process.env.INSPIRATION_LIBRARY_TEST_DATABASE_URL;
const suite=isolated?describe:describe.skip;
const key=generateKeyPairSync('ed25519'),keys={test:key.publicKey.export({type:'spki',format:'pem'}).toString()},origin='https://library.example.invalid';
const signed=<T extends object>(payload:T)=>{const value={...payload,key_id:'test'};return {...value,signature:sign(null,Buffer.from(canonical(value)),key.privateKey).toString('base64')};};
const context=(wsId:string)=>({params:Promise.resolve({wsId})});
const request=(body?:unknown)=>new Request(origin+'/api/test',{method:'POST',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});

suite('shared inspiration real PostgreSQL boundaries',()=>{
  let owner:string,other:string,member:string,admin:string,a:string,b:string,foreign:string,library:LibraryScope,ids:string[],spaces:string[];
  const extraIdentities:string[]=[];
  let image:Buffer;
  beforeAll(async()=>{
    const url=new URL(isolated!);
    if(url.hostname!=='127.0.0.1'||url.port!=='55439'||url.pathname!=='/nova_shared_inspiration_test'||process.env.DATABASE_URL!==isolated)throw new Error('Explicit isolated library PostgreSQL required');
    const prefix='library-test-'+randomUUID();[owner,other,member,admin]=['owner','other','member','admin'].map(x=>prefix+'-'+x);ids=[owner,other,member,admin];[a,b,foreign]=['a','b','foreign'].map(x=>prefix+'-'+x);spaces=[a,b,foreign];
    library={id:prefix+'-shared',kind:'SHARED',ownerId:owner,legacyWorkspaceId:null};
    await prisma.user.createMany({data:ids.map(id=>({id,email:id+'@example.invalid',isActive:true}))});
    await prisma.brandWorkspace.createMany({data:spaces.map((id,i)=>({id,name:'合成隔离品牌',ownerId:i===2?other:owner}))});
    await prisma.membership.createMany({data:[{workspaceId:a,userId:member,role:'VIEWER'},{workspaceId:b,userId:member,role:'VIEWER'}]});
    await prisma.inspirationLibrary.createMany({data:spaces.map((id,i)=>({id,kind:'WORKSPACE',ownerId:i===2?other:owner,legacyWorkspaceId:id}))});
    image=await sharp({create:{width:3,height:3,channels:3,background:'#225599'}}).png().toBuffer();
    auth.adminId=admin;auth.user={id:admin,email:admin+'@example.invalid'};
    vi.stubEnv('INSPIRATION_SHARED_LIBRARY_ID',library.id);
    expect((await initialize(request({libraryId:library.id,ownerId:owner}))).status).toBe(201);
  });
  beforeEach(async()=>{
    auth.user={id:owner,email:owner+'@example.invalid'};
    vi.stubEnv('INSPIRATION_SHARED_LIBRARY_ID',library.id);vi.stubEnv('INSPIRATION_ENABLED','true');vi.stubEnv('INSPIRATION_CONTENT_SYNC_MODE','manual');vi.stubEnv('INSPIRATION_RECEIVER_ORIGIN',origin);
    vi.stubEnv('INSPIRATION_PUBLISHER_URL','https://publisher.example.invalid/knowledge/v1');vi.stubEnv('INSPIRATION_SHARED_PUBLISHER_URL','https://publisher.example.invalid/knowledge/v2/libraries/'+library.id);vi.stubEnv('INSPIRATION_READ_TOKEN','synthetic-only');vi.stubEnv('INSPIRATION_TRUSTED_KEYS_JSON',JSON.stringify(keys));
    vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No real network or model calls in isolated library tests');}));
    await prisma.asyncTask.deleteMany({where:{workspaceId:{in:spaces}}});
    await prisma.inspirationChat.deleteMany({where:{workspaceId:{in:spaces}}});await prisma.inspirationBookmark.deleteMany({where:{workspaceId:{in:spaces}}});
    const where={libraryId:{in:[...spaces,library.id]}};
    await prisma.inspirationState.deleteMany({where});await prisma.inspirationRelease.deleteMany({where});await prisma.inspirationRecord.deleteMany({where});await prisma.inspirationImage.deleteMany({where});
  });
  afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
  afterAll(async()=>{if(ids){await prisma.asyncTask.deleteMany({where:{workspaceId:{in:spaces}}});await prisma.user.deleteMany({where:{id:{in:ids}}});await prisma.inspirationLibraryIdentity.deleteMany({where:{id:{in:[library.id,...extraIdentities]}}});}await prisma.$disconnect();});

  function pack(scope:LibraryScope=library,options:{version?:1|2;recipientId?:string;title?:string;release?:string;sequence?:number;kind?:'full'|'delta';parent?:string;caseId?:string}={}) {
    const version=options.version??(scope.kind==='SHARED'?2:1),recipient=version===2?{kind:'library',origin,library_id:options.recipientId??scope.id}:{origin,workspace_id:scope.id};
    const digest=sha256(image),path=`images/${digest}.png`,caseId=options.caseId??'common-case';
    const permissions={analysis:'allowed',display:'allowed',export:'allowed'};
    const value:PublishedCase={case_id:caseId,revision:1,title:options.title??'合成共享案例',summary_zh:'仅用于本机隔离验收',brand_or_team:'Synthetic',review_status:'approved',display_permission:'allowed',permissions,analysis_version:'v1',model_version:'none',tags:{industry:['culture'],medium:['poster']},sources:[{source_id:'s1',url:'https://source.example.invalid/case',display_permission:'allowed',permissions}],images:[{image_id:'image',source_id:'s1',path,display_permission:'allowed',permissions}],claims:[{claim_id:'claim',kind:'visual_observation',text:'合成蓝色方块',source_ids:[],image_ids:['image']}],editorial:{publication_use_basis:{schema_version:version,policy_id:'synthetic-policy',policy_sha256:'a'.repeat(64),purpose:'company_internal_inspiration',authorized_at:'2026-11-02T00:00:00Z',source_id:'potw',asset_id:caseId,revision:1,sha256:digest,input_binding:'b'.repeat(64),recipient,authorization_source:'operator_policy'}}};
    const record={op:'upsert',case_id:caseId,revision:1,case:value,content_hash:sha256(canonical(value))},records=Buffer.from(JSON.stringify(record)+'\n'),files=new Map([['records.jsonl',records],[path,image]]);
    const manifest=signed({schema_version:version,...(version===2?{recipient}:{}),release_id:options.release??'r1',sequence:options.sequence??1,kind:options.kind??'full',parent_release_id:options.parent??null,created_at:'2026-11-02T00:00:00Z',taxonomy_version:'nova-1',records_count:1,files:[...files].map(([path,bytes])=>({path,size:bytes.length,sha256:sha256(bytes)}))});
    return {raw:Buffer.from(JSON.stringify(manifest)),files,manifest,value};
  }
  it('initializes only by an administrator, replays the same owner, and rejects reassignment',async()=>{
    expect((await initialize(request({libraryId:library.id,ownerId:owner}))).status).toBe(403);
    auth.user={id:admin,email:admin+'@example.invalid'};
    const same=await initialize(request({libraryId:library.id,ownerId:owner}));expect(same.status).toBe(200);expect(await same.json()).toEqual({sourceLibrary:{id:library.id,kind:'SHARED'},created:false});
    expect((await initialize(request({libraryId:library.id,ownerId:other}))).status).toBe(409);
    expect((await prisma.inspirationLibrary.findUniqueOrThrow({where:{id:library.id}})).ownerId).toBe(owner);
  });
  it('retains permanent recipient ownership after deleting library data and rejects identity updates',async()=>{
    await prisma.inspirationLibrary.delete({where:{id:library.id}});
    expect((await prisma.inspirationLibraryIdentity.findUniqueOrThrow({where:{id:library.id}})).ownerId).toBe(owner);
    auth.user={id:admin,email:admin+'@example.invalid'};
    expect((await initialize(request({libraryId:library.id,ownerId:other}))).status).toBe(409);
    expect((await initialize(request({libraryId:library.id,ownerId:owner}))).status).toBe(201);
    await expect(prisma.inspirationLibraryIdentity.update({where:{id:library.id},data:{ownerId:other}})).rejects.toThrow();
    expect((await resolveLibrary(a)).ownerId).toBe(owner);
  });
  it('preserves the recipient tombstone after user deletion without changing account deletion semantics',async()=>{
    const id=library.id+'-deleted',gone=library.id+'-gone-owner';extraIdentities.push(id);ids.push(gone);
    await prisma.user.create({data:{id:gone,email:gone+'@example.invalid',isActive:true}});vi.stubEnv('INSPIRATION_SHARED_LIBRARY_ID',id);auth.user={id:admin,email:admin+'@example.invalid'};
    expect((await initialize(request({libraryId:id,ownerId:gone}))).status).toBe(201);
    await prisma.user.delete({where:{id:gone}});
    expect(await prisma.inspirationLibrary.findUnique({where:{id}})).toBeNull();expect((await prisma.inspirationLibraryIdentity.findUniqueOrThrow({where:{id}})).ownerId).toBe(gone);
    expect((await initialize(request({libraryId:id,ownerId:other}))).status).toBe(409);expect((await initialize(request({libraryId:id,ownerId:gone}))).status).toBe(404);
  });
  it('resolves both company brands to one library and excludes other owners and private legacy packages',async()=>{
    expect((await resolveLibrary(a)).id).toBe(library.id);expect((await resolveLibrary(b)).id).toBe(library.id);expect((await resolveLibrary(foreign)).id).toBe(foreign);
    await expect(resolveLibrary(foreign,library.id)).rejects.toThrow('不可访问');await expect(resolveLibrary(b,a)).rejects.toThrow('不可访问');
    const f=pack();await installPackage(library,f.raw,f.files,keys);
    for(const ws of [a,b]){const list=await listCases(ws);expect(list.sourceLibrary).toEqual({id:library.id,kind:'SHARED'});expect(list.caseCount).toBe(1);expect(list.cases[0]!.libraryId).toBe(library.id);}
    expect((await listCases(foreign)).caseCount).toBe(0);expect(await prisma.inspirationImage.count({where:{libraryId:library.id}})).toBe(1);
    const legacy=pack({id:a,kind:'WORKSPACE',ownerId:owner,legacyWorkspaceId:a});
    await expect(installPackage(library,legacy.raw,legacy.files,keys)).rejects.toThrow('recipient');
    await expect(installPackage(a,f.raw,f.files,keys)).rejects.toThrow('recipient');
  });
  it('shares one durable reception job across brands while preserving member permissions and running actor identity',async()=>{
    const replies=await Promise.all([receive(request(),context(a)),receive(request(),context(b))]);expect(replies.map(r=>r.status)).toEqual([202,202]);
    const first=await replies[0]!.json(),second=await replies[1]!.json();expect(first.id).toBe(second.id);expect(await prisma.asyncTask.count({where:{inspirationLibraryId:library.id}})).toBe(1);
    for(const ws of [a,b])expect((await (await receiveStatus(request(),context(ws))).json()).task.id).toBe(first.id);
    const before=await prisma.asyncTask.update({where:{id:first.id},data:{status:'RUNNING'}});await receive(request(),context(a));const after=await prisma.asyncTask.findUniqueOrThrow({where:{id:first.id}});expect(after.inputJson).toEqual(before.inputJson);expect(after.workspaceId).toBe(before.workspaceId);
    auth.user={id:member,email:member+'@example.invalid'};expect((await (await receiveStatus(request(),context(b))).json()).canReceive).toBe(false);expect((await receive(request(),context(b))).status).toBe(403);
    auth.user={id:other,email:other+'@example.invalid'};expect((await (await receiveStatus(request(),context(foreign))).json()).task).toBeNull();
  });
  it('validates every signed ancestor scope before downloading any image',async()=>{
    const parent=pack(library,{recipientId:'wrong-library',release:'parent'}),latest=pack(library,{release:'latest',sequence:2,kind:'delta',parent:'parent',caseId:'second'});
    const recipient={kind:'library',origin,library_id:library.id};const fetcher=vi.fn(async(url:string)=>{
      if(url.endsWith('/withdrawals/latest'))return Response.json({status:'empty',schema_version:2,recipient});
      if(url.endsWith('/latest'))return Response.json({status:'published',schema_version:2,recipient,release:{release_id:'latest',sequence:2,manifest_sha256:sha256(latest.raw)}});
      if(url.endsWith('/latest/manifest'))return new Response(new Uint8Array(latest.raw));
      if(url.endsWith('/parent/manifest'))return new Response(new Uint8Array(parent.raw));
      throw new Error('Unexpected image or body request');
    });vi.stubGlobal('fetch',fetcher);
    await expect(syncReplica(library,new AbortController().signal)).rejects.toThrow('recipient');expect(fetcher.mock.calls.some(([url])=>url.includes('/files/'))).toBe(false);expect(await prisma.inspirationImage.count({where:{libraryId:library.id}})).toBe(0);
  });
  it('rejects a case-level scope mismatch after metadata but before any images',async()=>{
    const f=pack(library,{recipientId:'wrong-library'}),recipient={kind:'library',origin,library_id:library.id};
    const {signature:_,key_id:__,...envelope}=f.manifest;const raw=Buffer.from(JSON.stringify(signed({...envelope,recipient})));
    const fetcher=vi.fn(async(url:string)=>{
      if(url.endsWith('/withdrawals/latest'))return Response.json({status:'empty',schema_version:2,recipient});
      if(url.endsWith('/latest'))return Response.json({status:'published',schema_version:2,recipient,release:{release_id:'r1',sequence:1,manifest_sha256:sha256(raw)}});
      if(url.endsWith('/manifest'))return new Response(new Uint8Array(raw));
      if(url.endsWith('/files/records.jsonl'))return new Response(new Uint8Array(f.files.get('records.jsonl')!));
      throw new Error('Unexpected image request');
    });vi.stubGlobal('fetch',fetcher);
    await expect(syncReplica(library,new AbortController().signal)).rejects.toThrow('recipient');expect(fetcher.mock.calls.some(([url])=>url.includes('/files/images/'))).toBe(false);
  });
  it('keeps shared image access brand-member gated and bookmarks project/user isolated',async()=>{
    const f=pack();await installPackage(library,f.raw,f.files,keys);
    const params=(wsId:string)=>({params:Promise.resolve({wsId,caseId:'common-case',imageId:'image'})});
    const read=new Request(origin+'/image?revision=1&libraryId='+library.id);
    auth.user={id:member,email:member+'@example.invalid'};expect((await imageRoute(read,params(b))).status).toBe(200);
    auth.user={id:other,email:other+'@example.invalid'};expect((await imageRoute(read,params(foreign))).status).toBe(404);
    auth.user={id:owner,email:owner+'@example.invalid'};const project=await prisma.project.create({data:{workspaceId:b,name:'合成项目'}});
    expect((await bookmark(request({libraryId:library.id,caseId:'common-case',revision:1,projectId:project.id}),context(a))).status).toBe(404);
    expect((await bookmark(request({libraryId:library.id,caseId:'common-case',revision:1,projectId:project.id}),context(b))).status).toBe(200);
    expect((await (await bookmarks(request(),context(a))).json()).items).toHaveLength(0);expect((await (await bookmarks(request(),context(b))).json()).items).toHaveLength(1);
    auth.user={id:member,email:member+'@example.invalid'};expect((await (await bookmarks(request(),context(b))).json()).items).toHaveLength(0);
  });
  it('pins old private chat evidence even when a shared case has the same identity and revision',async()=>{
    const privateScope={id:a,kind:'WORKSPACE' as const,ownerId:owner,legacyWorkspaceId:a};
    const old=pack(privateScope,{title:'原私有案例'}),shared=pack(library,{title:'公司共享案例'});await installPackage(privateScope,old.raw,old.files,keys);await installPackage(library,shared.raw,shared.files,keys);
    const chat=await createChat(a,owner,{libraryId:a,requestId:randomUUID(),question:'合成问题',caseIds:['common-case']});expect(chat.libraryId).toBe(a);
    await prisma.inspirationChat.update({where:{id:chat.id},data:{status:'SUCCEEDED',answer:'合成答案',citations:[{caseId:'common-case',revision:1}]}});
    const viewed=await getChat(a,owner,chat.id);expect(viewed.sourceLibrary?.id).toBe(a);expect(viewed.citations[0]!.title).toBe('原私有案例');
    await expect(createChat(a,owner,{libraryId:library.id,requestId:randomUUID(),question:'继续',conversationId:chat.conversationId,caseIds:['common-case']})).rejects.toThrow('绑定其他');
    expect((await listCases(a)).cases[0]!.title).toBe('公司共享案例');
  });
  it('rechecks receiver authority before commit and atomically rolls back staged database images',async()=>{
    const f=pack();let calls=0;
    await expect(installPackage(library,f.raw,f.files,keys,undefined,async()=>{if(++calls===2)throw new Error('Library receiver access changed');})).rejects.toThrow('access changed');
    expect(await prisma.inspirationImage.count({where:{libraryId:library.id}})).toBe(0);expect(await prisma.inspirationRecord.count({where:{libraryId:library.id}})).toBe(0);
    await expect(requireLibraryReceiver(library,a,member)).rejects.toThrow('access changed');await expect(requireLibraryReceiver(library,a,owner)).resolves.toBeUndefined();
    await prisma.user.update({where:{id:owner},data:{isActive:false}});await expect(requireLibraryReceiver(library,a,owner)).rejects.toThrow('access changed');await prisma.user.update({where:{id:owner},data:{isActive:true}});
  });
  it('requires the library recipient on signed withdrawals and removes shared cases for both brands',async()=>{
    const f=pack();await installPackage(library,f.raw,f.files,keys);const recipient={kind:'library',origin,library_id:library.id};
    const withdrawal={schema_version:2,recipient,sequence:1,created_at:'2026-11-02T00:00:00Z',case_ids:['common-case']};
    await expect(applyWithdrawal(library,Buffer.from(JSON.stringify(signed({...withdrawal,recipient:{...recipient,library_id:'wrong'}}))),keys)).rejects.toThrow('recipient');
    await applyWithdrawal(library,Buffer.from(JSON.stringify(signed(withdrawal))),keys);expect((await activeRecords(library)).records).toHaveLength(0);expect((await listCases(a)).caseCount).toBe(0);expect((await listCases(b)).caseCount).toBe(0);
  });
});

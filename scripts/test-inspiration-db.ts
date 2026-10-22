/** Explicit local integration test. Never run against a shared/remote DB.
 * INSPIRATION_DB_TEST=1 node --env-file=.env.local apps/web/node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json scripts/test-inspiration-db.ts
 * Fixtures are synthetic test evidence only, never published content or model acceptance.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

async function main() {
  if(process.env.INSPIRATION_DB_TEST!=='1')throw new Error('Explicit INSPIRATION_DB_TEST=1 required');
  const dbUrl=new URL(process.env.DATABASE_URL||'');
  if(!['127.0.0.1','localhost','[::1]'].includes(dbUrl.hostname)||!dbUrl.pathname.includes('nova'))throw new Error('Only isolated local Nova test DB allowed');
  const fixture=resolve('.novart-build/inspiration-integration',randomUUID());mkdirSync(fixture,{recursive:true});
  const python=process.env.OMNI_TEST_PYTHON||'D:/coding/OmniSignal/.venv/Scripts/python.exe';
  const omni=process.env.OMNI_TEST_ROOT||'D:/coding/OmniSignal';
  const generator=String.raw`
import sys,json
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[2])/'src'))
from omnisignal.knowledge.release import publish_release,publish_withdrawals,make_record as upsert_record,delete_record
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from PIL import Image
p=Path(sys.argv[1]); assets=p/'assets'; (assets/'images').mkdir(parents=True)
Image.new('RGB',(2,2),(160,120,230)).save(assets/'images/a.png')
key=Ed25519PrivateKey.generate()
(p/'public.pem').write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo))
def case(cid,rev):
 return {'case_id':cid,'revision':rev,'title':' 测试包装 '+str(rev)+' ','summary_zh':'仅用于集成测试的中文说明','brand_or_team':'测试团队','review_status':'approved','display_permission':'allowed','analysis_version':'test-1','model_version':'test-only','tags':{'industry':['测试'],'medium':['包装']},'sources':[{'source_id':'s1','url':'https://example.com/test-only','display_permission':'allowed'}],'images':[{'image_id':'i1','path':'images/a.png','source_id':'s1','display_permission':'allowed'}],'claims':[{'claim_id':'c1','kind':'author_statement','text':'测试证据','source_ids':['s1'],'image_ids':[]}], 'metadata':{'\ue000':'bmp','\U00010000':'nonbmp'}}
root=p/'publisher'
def release(rid,seq,records,kind='full',parent=None):
 publish_release(root=root,release_id=rid,sequence=seq,records=records,asset_root=assets,private_key=key,key_id='test',kind=kind,parent_release_id=parent,created_at='2026-10-22T00:00:00Z')
release('r1',1,[upsert_record(case('a',1)),upsert_record(case('b',1))])
release('r2',2,[upsert_record(case('a',2))],'delta','r1')
release('r3',3,[delete_record('b',2)],'delta','r2')
release('r4',4,[upsert_record(case('a',2))])
publish_withdrawals(root=root,sequence=1,case_ids=['a'],private_key=key,key_id='test')
print('test fixtures created')
`;
  execFileSync(python,['-X','utf8','-c',generator,fixture,omni],{stdio:['ignore','pipe','pipe']});
  const {prisma}=await import('../packages/db/src/index');
  const {installPackage,applyWithdrawal,activeRecords,rollbackReplica,syncReplica}=await import('../apps/web/src/lib/inspiration/replica');
  const {getCase,getChat,createChat,listCases}=await import('../apps/web/src/lib/inspiration/service');
  const {submitInspirationFeedback,listInspirationFeedback,reviewInspirationFeedback}=await import('../apps/web/src/lib/inspiration/feedback');
  const {requireWorkspaceRole}=await import('../apps/web/src/lib/workspace');
  const keys={test:readFileSync(join(fixture,'public.pem'),'utf8')};
  const load=(id:string)=>{const root=join(fixture,'publisher','releases',id),raw=readFileSync(join(root,'manifest.json'));const manifest=JSON.parse(raw.toString());return {raw,files:new Map<string,Buffer>(manifest.files.map((f:{path:string})=>[f.path,readFileSync(join(root,f.path))]))};};
  const install=async(ws:string,id:string)=>{const p=load(id);await installPackage(ws,p.raw,p.files,keys);};
  const run=randomUUID();const userId=`inspiration-test-${run}`,otherId=`inspiration-other-${run}`;const ws1=`inspiration-ws1-${run}`,ws2=`inspiration-ws2-${run}`;
  const results:string[]=[];
  const pass=(s:string)=>{results.push(s);console.log(`PASS ${s}`);};
  try {
    await prisma.user.createMany({data:[{id:userId,email:`${run}@integration.invalid`,name:'Integration fixture'},{id:otherId,email:`other-${run}@integration.invalid`,name:'Integration isolation'}]});
    await prisma.brandWorkspace.createMany({data:[{id:ws1,ownerId:userId,name:'Synthetic integration fixture'},{id:ws2,ownerId:otherId,name:'Synthetic isolation fixture'}]});
    await install(ws1,'r1');assert.equal((await activeRecords(ws1)).records.length,2);assert.equal((await getCase(ws1,'a')).case.title,' 测试包装 1 ');pass('actual Python signed full package and Unicode/whitespace interoperability');
    await install(ws1,'r1');assert.equal(await prisma.inspirationRelease.count({where:{workspaceId:ws1}}),1);pass('immutable replay is idempotent');
    const bad=load('r2');bad.files.set('images/a.png',Buffer.from('tampered'));await assert.rejects(installPackage(ws1,bad.raw,bad.files,keys));assert.equal((await activeRecords(ws1)).state?.activeRelease,'r1');pass('bad image hash preserves active release');
    await Promise.all([install(ws1,'r2'),install(ws1,'r2')]);assert.equal((await getCase(ws1,'a')).case.revision,2);assert.equal(await prisma.inspirationRelease.count({where:{workspaceId:ws1}}),2);pass('parallel same-release installation serializes safely');
    await assert.rejects(requireWorkspaceRole(ws1,otherId,'VIEWER'));assert.equal((await listCases(ws2)).cases.length,0);pass('workspace membership and storage isolation');
    const card=(await getCase(ws1,'a')).case;assert.equal(card.sources[0]?.url,'https://example.com/test-only');assert.equal((card as unknown as {metadata?:unknown}).metadata,undefined);assert.ok(card.images[0]!.url.startsWith(`/api/workspaces/${ws1}/`));pass('case cards expose evidence and local scoped image URLs only');
    await prisma.membership.create({data:{workspaceId:ws1,userId:otherId,role:'VIEWER'}});
    const ownFeedback=await submitInspirationFeedback(ws1,userId,{caseId:'a',revision:2,kind:'ANALYSIS_ERROR',note:'管理员测试反馈说明'});
    const memberFeedback=await submitInspirationFeedback(ws1,otherId,{caseId:'a',revision:2,kind:'BROKEN_IMAGE',note:'成员测试反馈说明'});
    assert.equal((await listInspirationFeedback(ws1,otherId)).items.length,1);assert.equal((await listInspirationFeedback(ws1,otherId)).items[0]?.id,memberFeedback.id);
    assert.equal((await listInspirationFeedback(ws1,userId,'review')).items.length,2);assert.equal((await listInspirationFeedback(ws2,otherId,'review')).items.length,0);pass('feedback own versus owner review scope stays inside workspace and user');
    await assert.rejects(listInspirationFeedback(ws1,otherId,'review'));await assert.rejects(reviewInspirationFeedback(ws1,otherId,ownFeedback.id,{status:'RESOLVED'}));await assert.rejects(reviewInspirationFeedback(ws2,otherId,ownFeedback.id,{status:'RESOLVED'}));pass('nonowner and foreign workspace cannot review or resolve feedback');
    await reviewInspirationFeedback(ws1,userId,memberFeedback.id,{status:'RESOLVED'});const persistedFeedback=await prisma.inspirationFeedback.findUniqueOrThrow({where:{id:memberFeedback.id}});assert.equal(persistedFeedback.note,'成员测试反馈说明');assert.equal(persistedFeedback.status,'RESOLVED');assert.equal((await listInspirationFeedback(ws1,userId,'review')).items.length,1);pass('owner resolution preserves note and removes only resolved review queue item');
    const chat=await prisma.inspirationChat.create({data:{workspaceId:ws1,userId,requestId:randomUUID(),conversationId:randomUUID(),question:'测试历史',caseIds:['a'],status:'SUCCEEDED',answer:'需要撤回的测试回答',citations:[{caseId:'a',revision:2}],expiresAt:new Date(Date.now()+60000)}});
    await prisma.inspirationBookmark.create({data:{workspaceId:ws1,userId,caseId:'a',revision:2,note:'用户自己的笔记'}});
    const request={requestId:randomUUID(),question:'并发幂等问题'};
    const requests=await Promise.all([createChat(ws1,userId,request),createChat(ws1,userId,request)]);assert.equal(requests[0].id,requests[1].id);await assert.rejects(createChat(ws1,userId,{...request,question:'不同内容'}));pass('real transaction chat idempotency and conflicting payload rejection');
    await install(ws1,'r3');await assert.rejects(getCase(ws1,'b'));await install(ws1,'r4');assert.equal((await activeRecords(ws1)).records.length,1);pass('delta deletion and full checkpoint materialization');
    await install(ws2,'r1');await applyWithdrawal(ws1,readFileSync(join(fixture,'publisher','withdrawals','1.json')),keys);
    assert.equal((await listCases(ws1)).cases.length,0);await assert.rejects(getCase(ws1,'a'));const hidden=await getChat(ws1,userId,chat.id);assert.equal(hidden.citations.length,0);assert.ok(!hidden.answer?.includes('需要撤回的测试回答'));assert.equal((await listCases(ws2)).cases.length,2);pass('withdrawal hides case/media lookup and historical answer without crossing tenants');
    const hiddenFeedback=await listInspirationFeedback(ws1,userId);assert.equal(hiddenFeedback.items[0]?.caseTitle,null);assert.equal(hiddenFeedback.items[0]?.unavailable,true);assert.equal(hiddenFeedback.items[0]?.note,'管理员测试反馈说明');await assert.rejects(submitInspirationFeedback(ws1,userId,{caseId:'a',revision:2,kind:'IRRELEVANT'}));pass('withdrawn feedback masks source title, retains user note and rejects new submission');
    const bookmarks=await prisma.inspirationBookmark.findMany({where:{workspaceId:ws1,userId}});assert.equal(bookmarks[0]?.note,'用户自己的笔记');assert.ok(!(await listCases(ws1)).cases.some(c=>c.caseId===bookmarks[0]!.caseId));pass('withdrawal retains user notes while referenced case becomes unavailable');
    await rollbackReplica(ws1,'r1');assert.equal((await activeRecords(ws1)).state?.releaseSequence,4);assert.equal((await activeRecords(ws1)).state?.withdrawalSequence,1);await assert.rejects(getCase(ws1,'a'));pass('rollback keeps sequence high-water and revocations');
    await assert.rejects(getChat(ws2,otherId,chat.id));pass('cross-workspace chat identifier does not grant access');
    const aborted=new AbortController();aborted.abort();const p=load('r2');await assert.rejects(installPackage(ws2,p.raw,p.files,keys,aborted.signal));assert.equal((await activeRecords(ws2)).state?.activeRelease,'r1');pass('cancelled install preserves ready version');
    const paths=new Map<string,Buffer>();for(const id of ['r1','r2','r3','r4']){const pack=load(id);paths.set(`/releases/${id}/manifest`,pack.raw);for(const [path,bytes]of pack.files)paths.set(`/releases/${id}/files/${path}`,bytes);}
    const pointer={release_id:'r3',sequence:3,manifest_sha256:createHash('sha256').update(load('r3').raw).digest('hex')};
    paths.set('/withdrawals/latest',Buffer.from(JSON.stringify({status:'empty',withdrawal:null})));paths.set('/latest',Buffer.from(JSON.stringify({status:'published',release:pointer})));
    const fetched:string[]=[];const server=createServer((req,res)=>{if(req.headers.authorization!=='Bearer local-fixture-token'){res.writeHead(401).end();return;}fetched.push(req.url!);const body=paths.get(req.url!);if(!body){res.writeHead(404).end();return;}res.writeHead(200,{'Content-Type':'application/json'}).end(body);});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
    const prior={url:process.env.INSPIRATION_PUBLISHER_URL,token:process.env.INSPIRATION_READ_TOKEN,keys:process.env.INSPIRATION_TRUSTED_KEYS_JSON};
    process.env.INSPIRATION_PUBLISHER_URL=`http://127.0.0.1:${address.port}`;process.env.INSPIRATION_READ_TOKEN='local-fixture-token';process.env.INSPIRATION_TRUSTED_KEYS_JSON=JSON.stringify(keys);
    try {
      await syncReplica(ws2,AbortSignal.timeout(10000));assert.equal((await activeRecords(ws2)).state?.activeRelease,'r3');assert.equal((await getCase(ws2,'a')).case.revision,2);await assert.rejects(getCase(ws2,'b'));pass('real loopback HTTP sync catches up two missed signed deltas');
      fetched.length=0;await syncReplica(ws2,AbortSignal.timeout(10000));assert.ok(!fetched.some(path=>path.includes('/files/')||path.includes('/r2/')));pass('already installed latest skips ancestor and asset redownload');
      paths.set('/latest',Buffer.from(JSON.stringify({status:'published',release:{...pointer,manifest_sha256:'0'.repeat(64)}})));await assert.rejects(syncReplica(ws2,AbortSignal.timeout(10000)));assert.equal((await activeRecords(ws2)).state?.activeRelease,'r3');pass('untrusted discovery hash mismatch cannot activate a release');
    }finally{
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      for(const [key,value]of Object.entries({INSPIRATION_PUBLISHER_URL:prior.url,INSPIRATION_READ_TOKEN:prior.token,INSPIRATION_TRUSTED_KEYS_JSON:prior.keys})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    }
    writeFileSync(join(fixture,'result.json'),JSON.stringify({synthetic:true,realDatabase:true,realPythonPublisher:true,paidModelCalls:0,checks:results},null,2));
  } finally {
    // IDs are freshly generated here, never taken from external input or broad prefixes.
    await prisma.$transaction(async tx=>{await tx.brandWorkspace.deleteMany({where:{id:{in:[ws1,ws2]},ownerId:{in:[userId,otherId]}}});await tx.user.deleteMany({where:{id:{in:[userId,otherId]}}});});
    await prisma.$disconnect();
  }
  console.log(JSON.stringify({passed:results.length,syntheticFixtures:true,retainedFixturePath:fixture,cleanup:'only created test users/workspaces'}));
}
main().catch(error=>{console.error(error instanceof Error ? `${error.name}: ${error.message.replace(/postgres(?:ql)?:\/\/\S+/g,'[redacted database URL]')}`:'Integration test failed');process.exitCode=1;});

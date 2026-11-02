import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import sharp from 'sharp';
const mocks=vi.hoisted(()=>({transaction:vi.fn(),lock:vi.fn(),state:vi.fn(),release:vi.fn(),records:vi.fn(),upsert:vi.fn(),oldRecord:vi.fn(),createRecord:vi.fn(),createImage:vi.fn(),createRelease:vi.fn(),update:vi.fn()}));
vi.mock('@brandai/db',()=>({prisma:{$transaction:mocks.transaction,inspirationState:{findUnique:mocks.state},inspirationRelease:{findUnique:mocks.release},inspirationRecord:{findMany:mocks.records}}}));
import { canonical, sha256, validatePackage, type PublishedCase } from '../src/lib/inspiration/protocol';
import { activeRecords, installPackage, rollbackReplica } from '../src/lib/inspiration/replica';
import { assertPublicationScope } from '../src/lib/inspiration/publication-scope';
const origin='https://receiver.invalid', key=generateKeyPairSync('ed25519'), keys={test:key.publicKey.export({format:'pem',type:'spki'}).toString()};
function signed<T extends object>(value:T){const payload={...value,key_id:'test'};return {...payload,signature:sign(null,Buffer.from(canonical(payload)),key.privateKey).toString('base64')};}
async function fixture(change?:(basis:Record<string,unknown>,value:PublishedCase)=>void){
  const bytes=await sharp({create:{width:3,height:3,channels:3,background:'#226644'}}).png().toBuffer(), digest=sha256(bytes),path=`images/${digest}.png`;
  const basis:Record<string,unknown>={schema_version:1,policy_id:'test-policy',policy_sha256:'a'.repeat(64),purpose:'company_internal_inspiration',authorized_at:'2026-11-02T14:00:00+08:00',source_id:'potw',asset_id:'case',revision:1,sha256:digest,input_binding:'b'.repeat(64),recipient:{origin,workspace_id:'workspace-a'},authorization_source:'operator_policy'};
  const value:PublishedCase={case_id:'case',revision:1,title:'隔离自有测试',summary_zh:'测试设计依据',brand_or_team:'Test',review_status:'approved',display_permission:'allowed',analysis_version:'v1',model_version:'test',tags:{industry:['culture'],medium:['poster']},sources:[{source_id:'s1',url:'https://source.invalid/art',display_permission:'allowed'}],images:[{image_id:'i1',source_id:'s1',path,display_permission:'allowed'}],claims:[{claim_id:'c1',kind:'visual_observation',text:'绿色区域',source_ids:['s1'],image_ids:['i1']}],editorial:{publication_use_basis:basis}};
  change?.(basis,value);
  const record={op:'upsert',case_id:value.case_id,revision:value.revision,case:value,content_hash:sha256(canonical(value))};
  const files=new Map([['records.jsonl',Buffer.from(JSON.stringify(record)+'\n')],[value.images[0]!.path,bytes]]);
  const manifest=signed({schema_version:1,release_id:'r1',sequence:1,kind:'full',parent_release_id:null,created_at:'2026-11-02T06:00:00Z',taxonomy_version:'nova-1',records_count:1,files:[...files].map(([path,b])=>({path,size:b.length,sha256:sha256(b)}))});
  return{raw:Buffer.from(JSON.stringify(manifest)),files,value,basis};
}
beforeEach(()=>{
  vi.clearAllMocks();vi.stubEnv('INSPIRATION_RECEIVER_ORIGIN',origin);
  mocks.state.mockResolvedValue({activeRelease:'r1',withdrawn:[]});mocks.release.mockResolvedValue(null);mocks.records.mockResolvedValue([]);
  mocks.upsert.mockResolvedValue({activeRelease:null,releaseSequence:0,withdrawn:[]});mocks.oldRecord.mockResolvedValue(null);mocks.createRecord.mockResolvedValue({id:'stored-case'});
  mocks.transaction.mockImplementation(async fn=>fn({$executeRaw:mocks.lock,inspirationState:{upsert:mocks.upsert,update:mocks.update,findUnique:mocks.state},inspirationRelease:{findUnique:mocks.release,create:mocks.createRelease},inspirationRecord:{findFirst:mocks.oldRecord,findMany:mocks.records,create:mocks.createRecord},inspirationImage:{create:mocks.createImage}}));
});
afterEach(()=>vi.unstubAllEnvs());

describe('internal publication recipient boundary',()=>{
  it('validates a real signed image package, then installs only into its configured receiver',async()=>{
    const f=await fixture();await installPackage('workspace-a',f.raw,f.files,keys);
    expect(mocks.createRecord).toHaveBeenCalledOnce();expect(mocks.createImage).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith({where:{workspaceId:'workspace-a'},data:{activeRelease:'r1',releaseSequence:1}});
  });
  it.each(['','https://another.invalid'])('rejects missing or mismatched trusted receiver origin before writes (%s)',async value=>{
    vi.stubEnv('INSPIRATION_RECEIVER_ORIGIN',value);const f=await fixture();await expect(installPackage('workspace-a',f.raw,f.files,keys)).rejects.toThrow('recipient');expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('rejects another workspace before transaction or image persistence',async()=>{
    const f=await fixture();await expect(installPackage('workspace-b',f.raw,f.files,keys)).rejects.toThrow('recipient');expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(['asset_id','revision','sha256','authorization_source','extra'])('rejects invalid or unbound %s even when the package is signed',async field=>{
    const f=await fixture(b=>{b[field]=field==='revision'?2:field==='sha256'?'f'.repeat(64):'invalid';});
    await expect(validatePackage(f.raw,f.files,keys)).rejects.toThrow();expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('checks the actual file digest rather than trusting its content-addressed path',async()=>{
    const f=await fixture((basis,value)=>{basis.sha256='f'.repeat(64);value.images[0]!.path=`images/${'f'.repeat(64)}.png`;});
    await expect(installPackage('workspace-a',f.raw,f.files,keys)).rejects.toThrow('checksum');expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('does not let a single-image basis cover additional images',async()=>{
    const f=await fixture((_b,c)=>c.images.push({...c.images[0]!,image_id:'extra'}));
    await expect(validatePackage(f.raw,f.files,keys)).rejects.toThrow('source binding');
  });
  it('retains legacy packages without an internal policy basis',async()=>{
    const f=await fixture((_b,c)=>{delete c.editorial;});vi.stubEnv('INSPIRATION_RECEIVER_ORIGIN','');
    await installPackage('workspace-a',f.raw,f.files,keys);expect(mocks.createRecord).toHaveBeenCalledOnce();
    expect(()=>assertPublicationScope(f.value,'workspace-b',null)).not.toThrow();
  });
  it('filters recipient-mismatched and malformed stored records on every content read',async()=>{
    const valid=await fixture(),wrong=await fixture(b=>{b.recipient={origin,workspace_id:'workspace-b'};}),invalid=await fixture(b=>{b.extra='unsupported';});
    const legacy=structuredClone(valid.value);delete legacy.editorial;
    mocks.release.mockResolvedValue({snapshot:{good:'r-good',wrong:'r-wrong',invalid:'r-invalid',legacy:'r-legacy'}});
    mocks.records.mockResolvedValue([{id:'r-good',body:valid.value},{id:'r-wrong',body:wrong.value},{id:'r-invalid',body:invalid.value},{id:'r-legacy',body:legacy}]);
    expect((await activeRecords('workspace-a')).records.map(r=>r.id)).toEqual(['r-good','r-legacy']);
    vi.stubEnv('INSPIRATION_RECEIVER_ORIGIN','');expect((await activeRecords('workspace-a')).records.map(r=>r.id)).toEqual(['r-legacy']);
    expect(mocks.records.mock.calls[0]![0].where.workspaceId).toBe('workspace-a');
  });
  it('refuses to reactivate a stored snapshot from a different receiver origin',async()=>{
    const f=await fixture(b=>{b.recipient={origin:'https://another.invalid',workspace_id:'workspace-a'};});
    mocks.release.mockResolvedValue({snapshot:{case:'stored-case'}});mocks.records.mockResolvedValue([{id:'stored-case',body:f.value}]);
    await expect(rollbackReplica('workspace-a','r1')).rejects.toThrow('recipient');expect(mocks.update).not.toHaveBeenCalled();
  });
  it('does not make a withdrawn scoped case block rollback, or restore it',async()=>{
    const f=await fixture(b=>{b.recipient={origin:'https://another.invalid',workspace_id:'workspace-a'};});
    mocks.state.mockResolvedValue({withdrawn:['case']});mocks.release.mockResolvedValue({snapshot:{case:'stored-case'}});mocks.records.mockResolvedValue([{id:'stored-case',body:f.value}]);
    await rollbackReplica('workspace-a','r1');expect(mocks.records).not.toHaveBeenCalled();expect(mocks.update).toHaveBeenCalledWith({where:{workspaceId:'workspace-a'},data:{activeRelease:'r1'}});
  });
});

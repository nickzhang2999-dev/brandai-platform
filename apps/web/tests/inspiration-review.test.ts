import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const db=vi.hoisted(()=>({inspirationChat:{findUnique:vi.fn(),count:vi.fn(),findFirst:vi.fn(),create:vi.fn()},brandWorkspace:{findUniqueOrThrow:vi.fn(),findMany:vi.fn()},$executeRaw:vi.fn(),$transaction:vi.fn()}));
vi.mock('@brandai/db',()=>({prisma:db,Prisma:{}}));
vi.mock('@/lib/api',()=>({ApiException:class extends Error{constructor(public status:number,message:string){super(message);}}}));
import { canonical, validatePackage } from '@/lib/inspiration/protocol';
import { createChat } from '@/lib/inspiration/service';
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const keys={review:publicKey.export({type:'spki',format:'pem'}).toString()};
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
// Independent Python json.dumps(sort_keys=True, ensure_ascii=False) profile for integer-only cases.
function pythonOrder(a:string,b:string):number {const ac=Array.from(a,c=>c.codePointAt(0)!),bc=Array.from(b,c=>c.codePointAt(0)!);for(let i=0;i<Math.min(ac.length,bc.length);i++){if(ac[i]!==bc[i])return ac[i]!-bc[i]!;}return ac.length-bc.length;}
function publisherCanonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(publisherCanonical).join(',')}]`;
  if(value && typeof value==='object')return `{${Object.keys(value).sort(pythonOrder).map(k=>`${JSON.stringify(k)}:${publisherCanonical((value as Record<string,unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function packageFor(extra:Record<string,unknown>={},taxonomy='1') {
  const image=await sharp({create:{width:1,height:1,channels:3,background:'#ffffff'}}).png().toBuffer();
  const c={case_id:'case-a',revision:1,title:'标题',summary_zh:'中文说明',brand_or_team:'设计团队',review_status:'approved',display_permission:'allowed',analysis_version:'1',model_version:'human',tags:{industry:['品牌'],medium:['包装']},sources:[{source_id:'source-a',url:'https://example.com/design',display_permission:'allowed'}],images:[{image_id:'image-a',path:'images/a.png',source_id:'source-a',display_permission:'allowed'}],claims:[{claim_id:'claim-a',kind:'author_statement',text:'原文说明',source_ids:['source-a'],image_ids:[]}],...extra};
  const record={op:'upsert',case_id:c.case_id,revision:c.revision,case:c,content_hash:digest(publisherCanonical(c))};
  const records=Buffer.from(publisherCanonical(record)+'\n');
  const unsigned={schema_version:1,release_id:'release-a',sequence:1,kind:'full',parent_release_id:null,created_at:'2026-10-22T00:00:00Z',taxonomy_version:taxonomy,records_count:1,files:[{path:'records.jsonl',size:records.length,sha256:digest(records)},{path:'images/a.png',size:image.length,sha256:digest(image)}],key_id:'review'};
  const manifest={...unsigned,signature:sign(null,Buffer.from(publisherCanonical(unsigned)),privateKey).toString('base64')};
  return {raw:Buffer.from(publisherCanonical(manifest)+'\n'),files:new Map([['records.jsonl',records],['images/a.png',image]])};
}
describe('independent publisher interoperability review',()=>{
  it('matches Python Unicode codepoint ordering, including non-BMP metadata keys',()=>{const data={'\u{10000}':'supplementary','\uE000':'bmp'};expect(canonical(data)).toBe('{"\uE000":"bmp","\u{10000}":"supplementary"}');});
  it('accepts publisher-signed case strings without trimming hash-covered content',async()=>{const p=await packageFor({title:' 标题 ',summary_zh:' 中文说明 ',brand_or_team:' 设计团队 '});const result=await validatePackage(p.raw,p.files,keys);expect(result.records[0]!.case!.title).toBe(' 标题 ');});
  it('accepts signed taxonomy text without altering the signature payload',async()=>{const p=await packageFor({},' taxonomy-1 ');expect((await validatePackage(p.raw,p.files,keys)).manifest.taxonomy_version).toBe(' taxonomy-1 ');});
  it('accepts source-authorized additional metadata whose keys sort differently in UTF-16',async()=>{const p=await packageFor({metadata:{'\u{10000}':'one','\uE000':'two'}});await expect(validatePackage(p.raw,p.files,keys)).resolves.toBeDefined();});
  it('rejects changed image bytes even when JSON and signature remain intact',async()=>{const p=await packageFor();p.files.set('images/a.png',Buffer.from('changed'));await expect(validatePackage(p.raw,p.files,keys)).rejects.toThrow('checksum');});
  it('rejects an unapproved case even with a trusted valid signature',async()=>{const p=await packageFor({review_status:'pending'});await expect(validatePackage(p.raw,p.files,keys)).rejects.toThrow();});
});
describe('chat request race review',()=>{
  const input={requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',question:'同一个问题'};
  beforeEach(()=>{vi.clearAllMocks();db.$transaction.mockImplementation(async(fn:(tx:typeof db)=>unknown)=>fn(db));db.brandWorkspace.findUniqueOrThrow.mockResolvedValue({ownerId:'owner'});db.brandWorkspace.findMany.mockResolvedValue([{id:'ws'}]);db.inspirationChat.count.mockResolvedValue(0);});
  it('rechecks conflicting input after another request wins the transaction lock',async()=>{
    db.inspirationChat.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({...input,question:'另一个问题',caseIds:[],conversationId:'conversation',id:'first'});
    await expect(createChat('ws','user',input)).rejects.toMatchObject({status:409});
  });
  it('returns a concurrent identical retry before quota checks',async()=>{
    const existing={...input,caseIds:[],conversationId:'conversation',id:'first'};db.inspirationChat.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);db.inspirationChat.count.mockResolvedValue(100);
    await expect(createChat('ws','user',input)).resolves.toMatchObject({id:'first'});expect(db.inspirationChat.create).not.toHaveBeenCalled();
  });
});

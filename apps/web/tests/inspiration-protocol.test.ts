import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import sharp from 'sharp';
import { canonical, sha256, validatePackage, verifySigned, PublishedCase, validateCase } from '../src/lib/inspiration/protocol';
const key=generateKeyPairSync('ed25519'),keys={test:key.publicKey.export({format:'pem',type:'spki'}).toString()};
function signed<T extends object>(value:T){const payload={...value,key_id:'test'};return {...payload,signature:sign(null,Buffer.from(canonical(payload)),key.privateKey).toString('base64')};}
async function fixture(change:(c:Record<string,unknown>)=>void=()=>{}) {
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#123456'}}).png().toBuffer();
  const c:Record<string,unknown>={case_id:'test-case',revision:1,title:' 测试案例 ',summary_zh:'测试说明',brand_or_team:'Test',review_status:'approved',display_permission:'allowed',analysis_version:'manual',model_version:'none',tags:{industry:['测试'],medium:['包装']},sources:[{source_id:'s1',url:'https://example.com/case',display_permission:'allowed'}],images:[{image_id:'i1',path:'images/a.png',source_id:'s1',display_permission:'allowed'}],claims:[{claim_id:'c1',kind:'visual_observation',text:'测试证据',source_ids:['s1'],image_ids:['i1']}]};change(c);
  const record={op:'upsert',case_id:c.case_id,revision:c.revision,case:c,content_hash:sha256(canonical(c))};
  const files=new Map([['records.jsonl',Buffer.from(JSON.stringify(record)+'\n')],['images/a.png',bytes]]);
  const manifest=signed({schema_version:1,release_id:'r1',sequence:1,kind:'full',parent_release_id:null,created_at:'2026-10-22T00:00:00Z',taxonomy_version:' v1 ',records_count:1,files:[...files].map(([path,b])=>({path,size:b.length,sha256:sha256(b)}))});
  return {raw:Buffer.from(JSON.stringify(manifest)+'\n'),files,manifest,c};
}
describe('signed knowledge protocol',()=>{
  it('accepts reviewed signed package without transforming whitespace',async()=>{const f=await fixture();const r=await validatePackage(f.raw,f.files,keys);expect(r.records[0]!.case!.title).toBe(' 测试案例 ');});
  it('uses Python Unicode codepoint sorting',()=>expect(canonical({'\u{10000}':1,'\ue000':2})).toBe('{"":2,"𐀀":1}'));
  it('rejects untrusted keys',()=>expect(()=>verifySigned(signed({x:1}),{})).toThrow('Unknown'));
  it('rejects changed signatures',()=>{const s=signed({x:1});expect(()=>verifySigned({...s,x:2},keys)).toThrow('signature');});
  it('rejects floats in the strict trial profile',()=>expect(()=>canonical({x:1.2})).toThrow());
  it('rejects corrupt image bytes',async()=>{const f=await fixture();f.files.set('images/a.png',Buffer.from('evil'));await expect(validatePackage(f.raw,f.files,keys)).rejects.toThrow('checksum');});
  it('rejects unreviewed case',async()=>{const f=await fixture(c=>{c.review_status='pending';});await expect(validatePackage(f.raw,f.files,keys)).rejects.toThrow();});
  it('rejects unknown display permissions',async()=>{const f=await fixture(c=>{c.display_permission='unknown';});await expect(validatePackage(f.raw,f.files,keys)).rejects.toThrow();});
  it('rejects source credentials',async()=>{const f=await fixture(c=>{(c.sources as {url:string}[])[0]!.url='https://secret@example.com';});await expect(validatePackage(f.raw,f.files,keys)).rejects.toThrow();});
  it('rejects broken evidence ids',async()=>{const f=await fixture(c=>{(c.claims as {source_ids:string[]}[])[0]!.source_ids=['bad'];});await expect(validatePackage(f.raw,f.files,keys)).rejects.toThrow('reference');});
  it('rejects duplicate source ids',async()=>{const f=await fixture(c=>{(c.sources as unknown[]).push((c.sources as unknown[])[0]);});await expect(validatePackage(f.raw,f.files,keys)).rejects.toThrow('Duplicate');});
  it('rejects traversal',async()=>{const f=await fixture(c=>{(c.images as {path:string}[])[0]!.path='images/../secret';});await expect(validatePackage(f.raw,f.files,keys)).rejects.toThrow();});
  it('rejects unlisted files',async()=>{const f=await fixture();f.files.set('images/extra.png',Buffer.from('x'));await expect(validatePackage(f.raw,f.files,keys)).rejects.toThrow('Incomplete');});
  // Python's isoformat() emits six fractional digits; the publisher used that until
  // 2026-10-30, so every signed package already on disk carries microseconds. Zod's
  // bare datetime() caps at three digits and rejected them before signature checking.
  it('accepts microsecond timestamps from the Python publisher',async()=>{
    const f=await fixture();
    const { signature: _s, key_id: _k, ...unsigned } = f.manifest as unknown as Record<string,unknown>;
    const raw=Buffer.from(JSON.stringify(signed({...unsigned,created_at:'2026-10-26T04:32:28.207868Z'}))+'\n');
    const r=await validatePackage(raw,f.files,keys);
    expect(r.records).toHaveLength(1);
  });
  it('still rejects non-UTC or malformed timestamps',async()=>{
    const f=await fixture();
    const { signature: _s, key_id: _k, ...unsigned } = f.manifest as unknown as Record<string,unknown>;
    for(const bad of ['2026-10-26T04:32:28.207868+08:00','2026-10-26 04:32:28','not-a-date']){
      const raw=Buffer.from(JSON.stringify(signed({...unsigned,created_at:bad}))+'\n');
      await expect(validatePackage(raw,f.files,keys)).rejects.toThrow();
    }
  });
});

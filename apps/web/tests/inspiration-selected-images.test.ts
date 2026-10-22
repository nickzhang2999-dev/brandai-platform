import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
const mocks=vi.hoisted(()=>({getCase:vi.fn(),findUnique:vi.fn()}));
vi.mock('@brandai/db',()=>({prisma:{inspirationImage:{findUnique:mocks.findUnique}}}));
vi.mock('../src/lib/inspiration/service',()=>({getCase:mocks.getCase}));
vi.mock('../src/lib/settings',()=>({getEffectiveAiSettings:async()=>({vlm:{provider:'openai',apiKey:'test-only',baseUrl:'https://example.com/v1',model:'test-vision'}})}));
vi.mock('../src/lib/studio-copywriting-provider',()=>({copywritingConfig:()=>({apiKey:'test-only',baseUrl:'https://example.com',model:'test-vision'}),copywritingEndpoint:()=> 'https://example.com/v1/messages'}));
import { loadSelectedImages } from '../src/lib/inspiration/selected-images';
import { answerEvidence, safeUsageCount } from '../src/lib/inspiration/provider';
import type { InspirationCaseCard } from '@brandai/contracts';
const card:InspirationCaseCard={caseId:'case-a',revision:1,title:'案例',summary:'测试说明',brandOrTeam:'Test',analysisAllowed:true,tags:{industry:['测试'],medium:['包装']},images:[{imageId:'i1',url:'/local'}],sources:[{sourceId:'s1',url:'https://example.com'}],claims:[{claimId:'c1',kind:'visual_observation',text:'有色块',sourceIds:['s1'],imageIds:['i1']}]};
const body={case_id:'case-a',revision:1,title:'案例',summary_zh:'测试说明',brand_or_team:'Test',review_status:'approved',display_permission:'allowed',analysis_version:'manual',model_version:'none',tags:card.tags,sources:[{source_id:'s1',url:'https://example.com',display_permission:'allowed'}],images:[{image_id:'i1',path:'images/a.png',source_id:'s1',display_permission:'allowed'}],claims:[{claim_id:'c1',kind:'visual_observation',text:'有色块',source_ids:['s1'],image_ids:['i1']}]};
const selected=[{caseId:'case-a',imageId:'i1',revision:1}];
beforeEach(()=>{mocks.getCase.mockResolvedValue({row:{releaseId:'r1',body},case:card});});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.clearAllMocks();});
describe('selected-image deep questions',()=>{
  it('bounds advisory provider token counts to database-safe integers',()=>{for(const value of [-1,Infinity,NaN,1.5,2147483648,'12',null,undefined])expect(safeUsageCount(value)).toBe(0);expect(safeUsageCount(12)).toBe(12);expect(safeUsageCount(0)).toBe(0);});
  it('reads only workspace/release/path local bytes and produces bounded JPEG',async()=>{
    const bytes=await sharp({create:{width:1200,height:900,channels:3,background:'#334455'}}).png().toBuffer();mocks.findUnique.mockResolvedValue({bytes,sha256:createHash('sha256').update(bytes).digest('hex')});
    const result=await loadSelectedImages('ws-a',selected,AbortSignal.timeout(5000));expect(mocks.findUnique).toHaveBeenCalledWith({where:{workspaceId_releaseId_path:{workspaceId:'ws-a',releaseId:'r1',path:'images/a.png'}}});
    const metadata=await sharp(Buffer.from(result[0]!.base64,'base64')).metadata();expect(metadata.format).toBe('jpeg');expect(metadata.width).toBeLessThanOrEqual(1024);expect(result[0]!.mimeType).toBe('image/jpeg');
  });
  it('denies analysis-unknown and never reads image bytes',async()=>{mocks.getCase.mockResolvedValue({row:{releaseId:'r1',body},case:{...card,analysisAllowed:false}});await expect(loadSelectedImages('ws',selected,AbortSignal.timeout(1000))).rejects.toThrow('未授权');expect(mocks.findUnique).not.toHaveBeenCalled();});
  it('rejects corrupt local bytes and duplicate selections',async()=>{mocks.findUnique.mockResolvedValue({bytes:Buffer.from('bad'),sha256:'0'.repeat(64)});await expect(loadSelectedImages('ws',selected,AbortSignal.timeout(1000))).rejects.toThrow('校验');await expect(loadSelectedImages('ws',[...selected,...selected],AbortSignal.timeout(1000))).rejects.toThrow('数量');});
  it.each(['admin','copywriting'])('sends exactly selected data images through %s protocol',async mode=>{
    if(mode==='copywriting')vi.stubEnv('INSPIRATION_CHAT_PROVIDER','copywriting');
    const text=JSON.stringify({sections:[{text:'图像观察：有色块。',caseId:'case-a',claimIds:['c1']}],limitations:'仅观察图片'});
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(mode==='copywriting'?{content:[{type:'text',text}],usage:{input_tokens:2,output_tokens:3}}:{choices:[{message:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3}})));vi.stubGlobal('fetch',fetch);
    await answerEvidence('分析图',[card],[],AbortSignal.timeout(1000),[{...selected[0]!,mimeType:'image/jpeg',base64:'TESTIMAGE'}]);
    const request=JSON.parse(fetch.mock.calls[0]![1].body);const message=request.messages.at(-1);expect(JSON.stringify(message.content)).toContain('TESTIMAGE');expect(JSON.stringify(message.content)).not.toContain('https://example.com');
    expect(message.content.filter((b:{type:string})=>b.type===(mode==='copywriting'?'image':'image_url'))).toHaveLength(1);
  });
  it('does not call model for analysis-denied records',async()=>{const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(answerEvidence('问题',[{...card,analysisAllowed:false}],[],AbortSignal.timeout(1000))).rejects.toThrow('未授权');expect(fetch).not.toHaveBeenCalled();});
});

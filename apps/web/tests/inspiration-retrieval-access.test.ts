import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InspirationCaseCard } from '@brandai/contracts';
const mocks=vi.hoisted(()=>({list:vi.fn(),user:vi.fn(),role:vi.fn(),embed:vi.fn(),rank:vi.fn()}));
vi.mock('@brandai/db',()=>({prisma:{user:{findUnique:mocks.user},inspirationEmbedding:{findUnique:vi.fn(),upsert:vi.fn()}}}));
vi.mock('../src/lib/workspace',()=>({requireWorkspaceRole:mocks.role}));
vi.mock('../src/lib/inspiration/service',()=>({listCases:mocks.list,keywordScore:()=>1}));
vi.mock('../src/lib/inspiration/semantic',()=>({embeddingConfig:()=>({dimensions:2}),embedTexts:mocks.embed,rankHybrid:mocks.rank}));
import { retrieveInspirationCases } from '../src/lib/inspiration/retrieval';
import { requireCurrentEvidence } from '../src/lib/inspiration/access';
const card=(n:number):InspirationCaseCard=>({caseId:`c${n}`,revision:1,title:`CASE${n}`,summary:'摘要',brandOrTeam:'Test',analysisAllowed:true,tags:{medium:['包装']},images:[],claims:[],sources:[]});
let current:InspirationCaseCard[];
beforeEach(()=>{vi.clearAllMocks();current=Array.from({length:17},(_,i)=>card(i));mocks.user.mockResolvedValue({isActive:true});mocks.role.mockResolvedValue({});mocks.list.mockImplementation(async()=>({cases:current}));mocks.embed.mockImplementation(async(_config,texts:string[])=>({ok:true,space:'s',vectors:texts.map(()=>[1,0])}));mocks.rank.mockImplementation((candidates)=>({searchMode:'hybrid',cases:candidates}));});
describe('outbound retrieval permission checkpoints',()=>{
  it('removes a withdrawn candidate before the next external batch, including final ranking',async()=>{
    let call=0;mocks.embed.mockImplementation(async(_config,texts:string[])=>{call++;if(call===2)current=current.filter(c=>c.caseId!=='c16');return{ok:true,space:'s',vectors:texts.map(()=>[1,0])};});
    const result=await retrieveInspirationCases('ws','user','QUESTION',AbortSignal.timeout(5000));
    expect(mocks.embed).toHaveBeenCalledTimes(2);expect(result.some(c=>c.caseId==='c16')).toBe(false);expect(JSON.stringify(mocks.embed.mock.calls)).not.toContain('CASE16');
  });
  it('rejects an updated revision or newly denied analysis permission even if cached vectors exist',async()=>{
    mocks.embed.mockImplementation(async(_config,texts:string[])=>{current=current.map(c=>c.caseId==='c0'?{...c,revision:2}:c.caseId==='c1'?{...c,analysisAllowed:false}:c);return{ok:true,space:'s',vectors:texts.map(()=>[1,0])};});
    const result=await retrieveInspirationCases('ws','user','QUESTION',AbortSignal.timeout(5000));
    expect(result.some(c=>['c0','c1'].includes(c.caseId))).toBe(false);expect(JSON.stringify(mocks.embed.mock.calls.slice(1))).not.toContain('CASE0');expect(JSON.stringify(mocks.embed.mock.calls.slice(1))).not.toContain('CASE1\\n');
  });
  it('rechecks active account before query embedding',async()=>{
    mocks.user.mockResolvedValueOnce({isActive:true}).mockResolvedValue({isActive:false});
    await expect(retrieveInspirationCases('ws','user','QUESTION',AbortSignal.timeout(5000))).rejects.toThrow('disabled');expect(mocks.embed).not.toHaveBeenCalled();
  });
  it('does not send a second document batch after role revocation',async()=>{
    let call=0;mocks.embed.mockImplementation(async(_config,texts:string[])=>{call++;if(call===2)mocks.role.mockRejectedValue(new Error('role removed'));return{ok:true,space:'s',vectors:texts.map(()=>[1,0])};});
    await expect(retrieveInspirationCases('ws','user','QUESTION',AbortSignal.timeout(5000))).rejects.toThrow('role removed');expect(mocks.embed).toHaveBeenCalledTimes(2);
  });
  it('rejects final selected image/text evidence if its version disappeared during preparation',async()=>{
    const evidence=[card(0)];current=[];await expect(requireCurrentEvidence('ws','user',evidence)).rejects.toThrow('更新');
  });
});

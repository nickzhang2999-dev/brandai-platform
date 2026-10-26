import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InspirationCaseCard } from '@brandai/contracts';
const mocks=vi.hoisted(()=>({find:vi.fn(),update:vi.fn(),history:vi.fn(),taskUpdate:vi.fn(),list:vi.fn(),settings:vi.fn()}));
vi.mock('@brandai/db',()=>({prisma:{inspirationChat:{findUnique:mocks.find,updateMany:mocks.update,findMany:mocks.history},asyncTask:{updateMany:mocks.taskUpdate}}}));
vi.mock('../src/lib/inspiration/service',()=>({listCases:mocks.list}));
vi.mock('../src/lib/settings',()=>({getEffectiveAiSettings:mocks.settings}));
vi.mock('../src/lib/studio-copywriting-provider',()=>({copywritingConfig:()=>({}),copywritingEndpoint:()=>''}));
vi.mock('../src/lib/inspiration/access',()=>({requireActiveEditor:async()=>{},requireCurrentEvidence:async()=>{}}));
vi.mock('../src/lib/inspiration/selected-images',()=>({loadSelectedImages:async()=>[]}));
vi.mock('../src/lib/inspiration/retrieval',()=>({retrieveInspirationCases:async()=>[]}));
vi.mock('../src/lib/inspiration/replica',()=>({syncReplica:vi.fn(),syncWithdrawals:vi.fn(),lockWorkspace:vi.fn()}));
import { runInspirationChat } from '../src/lib/inspiration/worker';

const currentCard=(caseId:string,taxonomyStatus:'reviewed'|'legacy',analysisAllowed=true):InspirationCaseCard=>({caseId,revision:1,title:'隔离案例',summary:'审核中文说明',brandOrTeam:'测试',analysisAllowed,taxonomyStatus,
  tags:taxonomyStatus==='legacy'?{industry:[],medium:[],task:[]}:{industry:['culture'],medium:['poster']},images:[],sources:[],
  claims:[{claimId:'claim-1',kind:'visual_observation',text:'图上可见字体层级',sourceIds:[],imageIds:[]}]});
const cards=[currentCard('legacy','legacy'),currentCard('reviewed','reviewed'),currentCard('denied','reviewed',false)];
const turn=(id:string,answer:string,citations:Array<{caseId:string;revision:number}>)=>({id,question:`历史问题 ${id}`,answer,citations});
const storedHistory=[
  turn('legacy-turn','旧默认值导致的 digital 数字界面判断',[{caseId:'legacy',revision:1}]),
  turn('mixed-turn','旧默认值 other 与普通案例的混合回答',[{caseId:'legacy',revision:1},{caseId:'reviewed',revision:1}]),
  turn('changed-turn','已过期的案例回答',[{caseId:'reviewed',revision:2}]),
  turn('denied-turn','已无分析权限的回答',[{caseId:'denied',revision:1}]),
  turn('reviewed-turn','可复用的已审核字体层级讨论',[{caseId:'reviewed',revision:1}]),
];
type Job={id:string;workspaceId:string;userId:string;status:string;question:string;selectedImages:never[];caseIds:string[];expiresAt:Date;createdAt:Date;conversationId:string};
type ModelPayload={question:string;history:Array<{question:string;answer:string|null}>;cases:Array<{caseId:string;tags:Record<string,string[]>}>};
let job:Job, payload:ModelPayload, fetcher:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  vi.clearAllMocks();vi.stubEnv('INSPIRATION_CHAT_PROVIDER','');
  job={id:'job',workspaceId:'ws',userId:'user',status:'PENDING',question:'分析这个案例',selectedImages:[],caseIds:['reviewed'],expiresAt:new Date(Date.now()+60000),createdAt:new Date(),conversationId:'conversation'};
  mocks.find.mockImplementation(async()=>({...job}));mocks.update.mockImplementation(async({where,data})=>{expect(where.id).toBe('job');Object.assign(job,data);return{count:1};});
  mocks.history.mockImplementation(async()=>structuredClone(storedHistory));mocks.taskUpdate.mockResolvedValue({count:1});mocks.list.mockImplementation(async()=>({cases:structuredClone(cards)}));
  mocks.settings.mockResolvedValue({vlm:{provider:'openai',model:'isolated-test',apiKey:'synthetic-key',baseUrl:'https://example.invalid/v1'}});
  // Actual worker and provider serialization; the network call is intercepted.
  fetcher=vi.fn(async(_url:string,init:RequestInit)=>{
    const request=JSON.parse(String(init.body));payload=JSON.parse(request.messages[1].content);
    const answer={sections:[{text:'依据当前证据重新分析',caseId:payload.cases[0]!.caseId,claimIds:['claim-1']}],limitations:'仅隔离测试'};
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]}));
  });vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe('legacy answers never reenter outbound model history',()=>{
  it('omits legacy and mixed rounds, retains valid history and leaves persisted UI history untouched',async()=>{
    const before=JSON.stringify(storedHistory);await runInspirationChat('job');
    expect(job.status).toBe('SUCCEEDED');expect(fetcher).toHaveBeenCalledOnce();
    expect(payload.history).toEqual([{question:'历史问题 reviewed-turn',answer:'可复用的已审核字体层级讨论'}]);
    expect(JSON.stringify(payload)).not.toMatch(/digital|other|数字界面|已过期的案例回答|已无分析权限/);
    expect(JSON.stringify(storedHistory)).toBe(before);
    expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({workspaceId:'ws',userId:'user',conversationId:'conversation'})}));
    expect(mocks.update.mock.calls.every(([input])=>input.where.id==='job')).toBe(true);
  });
  it('keeps ordinal references usable while sending only current cleaned evidence, not the old answer',async()=>{
    job.caseIds=[];job.question='比较第一个案例的字体';await runInspirationChat('job');
    expect(job.status).toBe('SUCCEEDED');expect(fetcher).toHaveBeenCalledOnce();
    expect(payload.cases.map(c=>c.caseId)).toEqual(['legacy']);
    expect(payload.cases[0]!.tags).toEqual({industry:[],medium:[],task:[]});
    expect(payload.history).toEqual([{question:'历史问题 reviewed-turn',answer:'可复用的已审核字体层级讨论'}]);
    expect(JSON.stringify(payload)).not.toMatch(/digital|other|数字界面/);
  });
});

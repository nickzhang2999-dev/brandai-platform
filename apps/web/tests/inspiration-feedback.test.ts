import {beforeEach,describe,expect,it,vi} from 'vitest';
const f=vi.hoisted(()=>({findMany:vi.fn(),create:vi.fn(),updateMany:vi.fn(),role:vi.fn(),active:vi.fn(),getCase:vi.fn(),enabled:vi.fn()}));
vi.mock('@brandai/db',()=>({prisma:{inspirationFeedback:{findMany:f.findMany,create:f.create,updateMany:f.updateMany}}}));
vi.mock('@/lib/api',()=>({ApiException:class extends Error{constructor(public status:number,message:string){super(message);}}}));
vi.mock('@/lib/workspace',()=>({requireWorkspaceRole:f.role}));
vi.mock('@/lib/inspiration/replica',()=>({activeRecords:f.active}));
vi.mock('@/lib/inspiration/service',()=>({getCase:f.getCase,requireEnabled:f.enabled}));
import {listInspirationFeedback,submitInspirationFeedback,reviewInspirationFeedback} from '@/lib/inspiration/feedback';
import {InspirationFeedbackInput,InspirationFeedbackUpdate} from '@brandai/contracts';
const row={id:'feedback',caseId:'case-a',revision:2,kind:'ANALYSIS_ERROR',note:'用户自己的说明',status:'OPEN',createdAt:new Date(0)};
beforeEach(()=>{vi.resetAllMocks();f.role.mockResolvedValue({role:'VIEWER'});f.findMany.mockResolvedValue([row]);f.create.mockResolvedValue(row);f.updateMany.mockResolvedValue({count:1});f.active.mockResolvedValue({records:[{caseId:'case-a',revision:2,body:{title:'当前标题',summary_zh:'private-source-body'}}]});f.getCase.mockResolvedValue({case:{caseId:'case-a',revision:2,title:'当前标题'}});});
describe('private case feedback workflow',()=>{
  it('validates all supported kinds, bounded note and rejects caller supplied identity/status',()=>{
    for(const kind of ['IRRELEVANT','ANALYSIS_ERROR','UNSUPPORTED_CITATION','BROKEN_IMAGE'])expect(InspirationFeedbackInput.parse({caseId:'a',revision:1,kind,note:' 说明 '})).toMatchObject({note:'说明'});
    expect(InspirationFeedbackInput.safeParse({caseId:'a',revision:1,kind:'IRRELEVANT',note:'a'.repeat(1001)}).success).toBe(false);
    expect(InspirationFeedbackInput.safeParse({caseId:'a',revision:1,kind:'IRRELEVANT',userId:'other'}).success).toBe(false);
    expect(InspirationFeedbackUpdate.safeParse({status:'RESOLVED',note:'overwrite'}).success).toBe(false);
  });
  it('allows a member to submit only against the current accessible case version',async()=>{
    await submitInspirationFeedback('ws','user',{caseId:'case-a',revision:2,kind:'ANALYSIS_ERROR',note:'用户自己的说明'});
    expect(f.role).toHaveBeenCalledWith('ws','user','VIEWER');expect(f.getCase).toHaveBeenCalledWith('ws','case-a',2);
    expect(f.create.mock.calls[0]![0].data).toEqual({workspaceId:'ws',userId:'user',caseId:'case-a',revision:2,kind:'ANALYSIS_ERROR',note:'用户自己的说明',status:'OPEN'});
  });
  it('never stores feedback when the case is withdrawn, stale or inaccessible',async()=>{f.getCase.mockRejectedValue(new Error('unavailable'));await expect(submitInspirationFeedback('ws','user',{caseId:'case-a',revision:2,kind:'BROKEN_IMAGE'})).rejects.toThrow('unavailable');expect(f.create).not.toHaveBeenCalled();});
  it('defaults to own workspace+user records and does not expose source bodies',async()=>{const result=await listInspirationFeedback('ws','user');expect(f.findMany.mock.calls[0]![0].where).toEqual({workspaceId:'ws',userId:'user'});expect(result).toMatchObject({scope:'mine',canReview:false,items:[{caseTitle:'当前标题',unavailable:false}]});expect(JSON.stringify(result)).not.toContain('private-source-body');});
  it('masks withdrawn or superseded source title while preserving the user note',async()=>{f.active.mockResolvedValue({records:[{caseId:'case-a',revision:3,body:{title:'private-new-version'}}]});const result=await listInspirationFeedback('ws','user');expect(result.items[0]).toMatchObject({caseTitle:null,unavailable:true,note:'用户自己的说明'});expect(JSON.stringify(result)).not.toContain('private-new-version');});
  it('requires owner role before querying workspace review queue',async()=>{f.role.mockRejectedValue(new Error('forbidden'));await expect(listInspirationFeedback('ws','user','review')).rejects.toThrow('forbidden');expect(f.role).toHaveBeenCalledWith('ws','user','OWNER');expect(f.findMany).not.toHaveBeenCalled();});
  it('owners see only current workspace open feedback, never all tenants',async()=>{f.role.mockResolvedValue({role:'OWNER'});const result=await listInspirationFeedback('ws','owner','review');expect(f.findMany.mock.calls[0]![0].where).toEqual({workspaceId:'ws',status:'OPEN'});expect(result.canReview).toBe(true);});
  it('owner closes/reopens a workspace record without editing note or source data',async()=>{f.role.mockResolvedValue({role:'OWNER'});expect(await reviewInspirationFeedback('ws','owner','feedback',{status:'RESOLVED'})).toEqual({id:'feedback',status:'RESOLVED'});expect(f.role).toHaveBeenCalledWith('ws','owner','OWNER');expect(f.updateMany).toHaveBeenCalledWith({where:{id:'feedback',workspaceId:'ws'},data:{status:'RESOLVED'}});expect(f.create).not.toHaveBeenCalled();});
  it('foreign/deleted feedback remains unenumerable',async()=>{f.updateMany.mockResolvedValue({count:0});await expect(reviewInspirationFeedback('ws','owner','foreign',{status:'RESOLVED'})).rejects.toMatchObject({status:404});});
  it('feature disabled stops every feedback query and mutation',async()=>{f.enabled.mockImplementation(()=>{throw new Error('disabled');});await expect(listInspirationFeedback('ws','user')).rejects.toThrow('disabled');await expect(reviewInspirationFeedback('ws','owner','feedback',{status:'OPEN'})).rejects.toThrow('disabled');expect(f.role).not.toHaveBeenCalled();expect(f.findMany).not.toHaveBeenCalled();expect(f.updateMany).not.toHaveBeenCalled();});
});

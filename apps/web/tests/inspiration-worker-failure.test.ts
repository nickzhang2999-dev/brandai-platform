import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({find:vi.fn(),update:vi.fn(),history:vi.fn(),taskUpdate:vi.fn(),list:vi.fn(),answer:vi.fn()}));
vi.mock('@brandai/db',()=>({prisma:{inspirationChat:{findUnique:mocks.find,updateMany:mocks.update,findMany:mocks.history},asyncTask:{updateMany:mocks.taskUpdate}}}));
vi.mock('../src/lib/inspiration/service',()=>({listCases:mocks.list}));
vi.mock('../src/lib/inspiration/provider',()=>({answerEvidence:mocks.answer}));
vi.mock('../src/lib/inspiration/access',()=>({requireActiveEditor:async()=>{},requireCurrentEvidence:async()=>{}}));
vi.mock('../src/lib/inspiration/selected-images',()=>({loadSelectedImages:async()=>[]}));
vi.mock('../src/lib/inspiration/retrieval',()=>({retrieveInspirationCases:async()=>[]}));
vi.mock('../src/lib/inspiration/replica',()=>({syncReplica:vi.fn(),syncWithdrawals:vi.fn(),lockWorkspace:vi.fn()}));
import { runInspirationChat } from '../src/lib/inspiration/worker';
import { InspirationFailure } from '../src/lib/inspiration/failure';

beforeEach(()=>{
  vi.clearAllMocks();
  const row={id:'job',workspaceId:'ws',userId:'user',status:'PENDING',question:'private-user-content',selectedImages:[],caseIds:['case'],expiresAt:new Date(Date.now()+60000),createdAt:new Date(),conversationId:'conversation'};
  mocks.find.mockImplementation(async()=>({...row}));
  mocks.update.mockImplementation(async({data})=>{Object.assign(row,data);return{count:1};});
  mocks.history.mockResolvedValue([]);mocks.taskUpdate.mockResolvedValue({count:1});
  mocks.list.mockResolvedValue({cases:[{caseId:'case',revision:1,analysisAllowed:true}]});
});
afterEach(()=>vi.restoreAllMocks());

describe('inspiration worker safe terminal diagnostics',()=>{
  it.each([new InspirationFailure('provider_http_error',400),new Error('private-provider-key/response')])('keeps frontend generic, logs safe fields and never retries',async(error)=>{
    mocks.answer.mockRejectedValue(error);const log=vi.spyOn(console,'warn').mockImplementation(()=>{});
    await runInspirationChat('job');
    expect(mocks.answer).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('[inspiration-chat] failed',error instanceof InspirationFailure?{code:'provider_http_error',status:400}:{code:'task_failed'});
    const failure=mocks.update.mock.calls.find(([arg])=>arg.data.status==='FAILED')?.[0];
    expect(failure.data.error).toBe('灵感任务未完成，请检查接入配置或稍后重试。');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-');expect(JSON.stringify(mocks.update.mock.calls)).not.toContain('private-');
    expect(mocks.taskUpdate.mock.calls.at(-1)?.[0].data.status).toBe('FAILED');
    await runInspirationChat('job');expect(mocks.answer).toHaveBeenCalledOnce();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({chatUpdate:vi.fn(),chatFind:vi.fn(),taskUpdate:vi.fn(),taskFind:vi.fn(),states:vi.fn(),sync:vi.fn(),withdrawals:vi.fn(),transaction:vi.fn()}));
vi.mock('@brandai/db',()=>({prisma:{inspirationChat:{updateMany:mocks.chatUpdate,findFirst:mocks.chatFind},asyncTask:{findFirst:mocks.taskFind,updateMany:mocks.taskUpdate},inspirationState:{findMany:mocks.states},$transaction:mocks.transaction}}));
vi.mock('@/lib/inspiration/service',()=>({listCases:vi.fn()}));vi.mock('@/lib/inspiration/provider',()=>({answerEvidence:vi.fn()}));
vi.mock('@/lib/inspiration/selected-images',()=>({loadSelectedImages:vi.fn()}));vi.mock('@/lib/inspiration/access',()=>({requireActiveEditor:vi.fn(),requireCurrentEvidence:vi.fn()}));vi.mock('@/lib/inspiration/retrieval',()=>({retrieveInspirationCases:vi.fn()}));
vi.mock('@/lib/inspiration/replica',()=>({syncReplica:mocks.sync,syncWithdrawals:mocks.withdrawals,lockWorkspace:vi.fn()}));
import { createInspirationWorker } from '../src/lib/inspiration/worker';
import { contentSyncMode, receiverOrigin } from '../src/lib/inspiration/config';
let worker:ReturnType<typeof createInspirationWorker>|undefined;
beforeEach(()=>{
  vi.clearAllMocks();vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-02T06:00:00Z'));
  vi.stubEnv('INSPIRATION_ENABLED','true');vi.stubEnv('INSPIRATION_CONTENT_SYNC_MODE','manual');vi.stubEnv('INSPIRATION_PUBLISHER_URL','https://publisher.invalid/knowledge/v1');vi.stubEnv('INSPIRATION_READ_TOKEN','synthetic');vi.stubEnv('INSPIRATION_TRUSTED_KEYS_JSON','{"test":"synthetic"}');
  mocks.chatUpdate.mockResolvedValue({count:0});mocks.chatFind.mockResolvedValue(null);mocks.taskFind.mockResolvedValue(null);mocks.taskUpdate.mockResolvedValue({count:1});mocks.states.mockResolvedValue([{workspaceId:'workspace-a'}]);mocks.sync.mockResolvedValue(undefined);mocks.withdrawals.mockResolvedValue(undefined);
});
afterEach(async()=>{await worker?.close();worker=undefined;vi.useRealTimers();vi.unstubAllEnvs();});
describe('manual content reception preserves automatic withdrawals',()=>{
  it('does not discover or enqueue content while withdrawals run immediately and every minute',async()=>{
    worker=createInspirationWorker();await vi.advanceTimersByTimeAsync(1);
    expect(mocks.taskFind.mock.calls[0]![0].where.inputJson).toEqual({path:['trigger'],equals:'manual'});expect(mocks.transaction).not.toHaveBeenCalled();expect(mocks.sync).not.toHaveBeenCalled();expect(mocks.withdrawals).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);expect(mocks.withdrawals).toHaveBeenCalledTimes(2);expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.states.mock.calls.every(([arg])=>arg.select?.workspaceId===true)).toBe(true);
  });
  it('runs an explicitly received task once and records terminal success',async()=>{
    mocks.taskFind.mockResolvedValueOnce({id:'task',workspaceId:'workspace-a',expiresAt:new Date(Date.now()+360000)});
    worker=createInspirationWorker();await vi.advanceTimersByTimeAsync(1);
    expect(mocks.sync).toHaveBeenCalledOnce();expect(mocks.sync.mock.calls[0]![0]).toBe('workspace-a');
    expect(mocks.taskUpdate).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({id:'task',status:'RUNNING'}),data:{status:'SUCCEEDED',progress:100}}));
    await vi.advanceTimersByTimeAsync(5000);expect(mocks.sync).toHaveBeenCalledOnce();
  });
  it('records safe failure without retrying a failed manual task',async()=>{
    mocks.taskFind.mockResolvedValueOnce({id:'task',workspaceId:'workspace-a',expiresAt:new Date(Date.now()+360000)});mocks.sync.mockRejectedValue(new Error('private-token'));
    worker=createInspirationWorker();await vi.advanceTimersByTimeAsync(10001);expect(mocks.sync).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.taskUpdate.mock.calls)).not.toContain('private-token');expect(mocks.taskUpdate.mock.calls.some(([arg])=>arg.data.status==='FAILED')).toBe(true);
  });
  it('preserves automatic default but treats unknown explicit modes as manual',()=>{
    vi.stubEnv('INSPIRATION_CONTENT_SYNC_MODE','');expect(contentSyncMode()).toBe('automatic');vi.stubEnv('INSPIRATION_CONTENT_SYNC_MODE','automatic');expect(contentSyncMode()).toBe('automatic');vi.stubEnv('INSPIRATION_CONTENT_SYNC_MODE','typo');expect(contentSyncMode()).toBe('manual');
  });
  it.each(['','http://app.invalid','https://app.invalid/','https://secret@app.invalid','https://app.invalid/path','https://app.invalid?x=1'])('rejects noncanonical receiver origin %s',value=>{vi.stubEnv('INSPIRATION_RECEIVER_ORIGIN',value);expect(receiverOrigin()).toBeNull();});
  it('accepts a configured exact HTTPS origin',()=>{vi.stubEnv('INSPIRATION_RECEIVER_ORIGIN','https://app.invalid');expect(receiverOrigin()).toBe('https://app.invalid');});
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { continueSnapshotInput, SNAPSHOT_INTENT_MS, InspirationSyncClaimLost,type SnapshotTaskInput } from '../src/lib/inspiration/snapshot-tasks';
const f = vi.hoisted(() => ({taskFind: vi.fn(), taskMany: vi.fn(), taskCurrent: vi.fn(), taskUpdate: vi.fn(), chatFind: vi.fn(), chatUpdate: vi.fn(), library: vi.fn(), states: vi.fn(), sync: vi.fn(), withdrawals: vi.fn(), receiver: vi.fn(), transaction: vi.fn()}));
vi.mock('@brandai/db', () => ({Prisma:{AnyNull:'synthetic-json-null'},prisma: {
  inspirationLibraryTask: {findFirst: f.taskFind, findMany: f.taskMany, findUnique:f.taskCurrent,updateMany: f.taskUpdate}, inspirationChat: {findFirst: f.chatFind, updateMany: f.chatUpdate},
  inspirationLibrary: {findUnique: f.library}, inspirationState: {findMany: f.states}, $transaction: f.transaction,
}}));
vi.mock('../src/lib/inspiration/config', () => ({contentSyncMode: () => 'manual', inspirationEnabled: () => true, syncConfigured: () => true}));
vi.mock('../src/lib/inspiration/service', () => ({currentCases: vi.fn()}));
vi.mock('../src/lib/inspiration/provider', () => ({answerEvidence: vi.fn()}));
vi.mock('../src/lib/inspiration/selected-images', () => ({loadSelectedImages: vi.fn()}));
vi.mock('../src/lib/inspiration/access', () => ({requireLibraryReceiver: f.receiver, requireActiveEditor: vi.fn(), requireCurrentEvidence: vi.fn()}));
vi.mock('../src/lib/inspiration/retrieval', () => ({retrieveInspirationCases: vi.fn()}));
vi.mock('../src/lib/inspiration/replica', () => ({syncReplica: f.sync, syncWithdrawals: f.withdrawals, lockWorkspace: vi.fn()}));
import { createInspirationWorker } from '../src/lib/inspiration/worker';

const now = new Date('2026-11-06T06:00:00Z');
let worker: ReturnType<typeof createInspirationWorker> | undefined;
const task = () => ({id: 'synthetic-task', workspaceId: 'synthetic-workspace', inspirationLibraryId: 'synthetic-library', expiresAt: new Date(Date.now() + 360000), inputJson: {trigger: 'manual', userId: 'synthetic-user', workspaceId: 'synthetic-workspace'}});
beforeEach(() => {
  vi.resetAllMocks();vi.useFakeTimers();vi.setSystemTime(now);vi.stubEnv('INSPIRATION_SNAPSHOT_V3_ENABLED', 'true');
  f.taskMany.mockResolvedValue([]);f.taskFind.mockResolvedValue(null);f.taskUpdate.mockResolvedValue({count: 1});f.chatFind.mockResolvedValue(null);f.chatUpdate.mockResolvedValue({count: 0});
  f.library.mockResolvedValue({id: 'synthetic-library', kind: 'SHARED', ownerId: 'synthetic-owner', legacyWorkspaceId: null});f.states.mockResolvedValue([]);f.receiver.mockResolvedValue(undefined);
  f.taskCurrent.mockImplementation(async()=>{const claim=[...f.taskUpdate.mock.calls].reverse().find(([call])=>call.data.inputJson?.syncClaimId)?.[0];return claim?{status:'RUNNING',expiresAt:claim.where.expiresAt,inputJson:claim.data.inputJson}:null;});
});
afterEach(async () => {await worker?.close();worker = undefined;vi.useRealTimers();vi.unstubAllEnvs();});
describe('fixed-root bounded worker continuation', () => {
  it('keeps root and start time while bounding chunk count and elapsed lifetime', () => {
    const first = continueSnapshotInput({trigger: 'manual', userId: 'synthetic-user'}, 'fixed-session', now);
    const next = continueSnapshotInput(first, 'fixed-session', new Date(now.getTime() + 6000));
    expect(next).toMatchObject({snapshotSessionId: 'fixed-session', snapshotStartedAt: now.toISOString(), snapshotChunks: 2, userId: 'synthetic-user'});
    expect(() => continueSnapshotInput(first, 'other-session', now)).toThrow('conflict');
    expect(() => continueSnapshotInput(first, 'fixed-session', new Date(now.getTime() + SNAPSHOT_INTENT_MS))).toThrow('expired');
    expect(() => continueSnapshotInput({...first, snapshotChunks: 20000}, 'fixed-session', now)).toThrow('expired');
  });
  it('pins a manual intent, returns it to pending for an incomplete tick, and never announces success', async () => {
    f.taskFind.mockResolvedValueOnce(task());
    f.sync.mockImplementation(async (_library, _signal, _recheck, continuation) => {
      await continuation.onSession('fixed-session');
      return {sessionId: 'fixed-session', status: 'DOWNLOADING', complete: false, bytes: 12, objects: 1};
    });
    worker = createInspirationWorker();await vi.advanceTimersByTimeAsync(1);
    expect(f.receiver).toHaveBeenCalledOnce();
    expect(f.taskUpdate).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({inputJson: expect.objectContaining({snapshotSessionId: 'fixed-session'})})}));
    expect(f.taskUpdate).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({status: 'PENDING', resultJson: expect.objectContaining({phase: 'DOWNLOADING'})})}));
    expect(f.taskUpdate.mock.calls.some(([arg]) => arg.data.status === 'SUCCEEDED')).toBe(false);
    expect(f.transaction).not.toHaveBeenCalled(); // A manual receive never enables automatic discovery.
  });
  it('rechecks receiver authority before a continued chunk without touching remote work', async () => {
    const current = task();Object.assign(current.inputJson, {snapshotSessionId: 'fixed-session', snapshotStartedAt: now.toISOString()});
    f.taskFind.mockResolvedValueOnce(current);f.receiver.mockRejectedValue(new Error('Library receiver access changed'));
    worker = createInspirationWorker();await vi.advanceTimersByTimeAsync(1);
    expect(f.sync).not.toHaveBeenCalled();expect(f.taskUpdate).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({status: 'FAILED', resultJson: {failureCode: 'RECEIVER_ACCESS_CHANGED'}})}));
  });
  it('reports waiting capacity as a preserved session rather than completion', async () => {
    f.taskFind.mockResolvedValueOnce(task());f.sync.mockResolvedValue({sessionId: 'fixed-session', status: 'WAITING_CAPACITY', complete: false, bytes: 0, objects: 0});
    worker = createInspirationWorker();await vi.advanceTimersByTimeAsync(1);
    expect(f.taskUpdate).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({status: 'FAILED', resultJson: expect.objectContaining({snapshotSessionId: 'fixed-session', failureCode: 'SNAPSHOT_CAPACITY'})})}));
    expect(f.taskUpdate.mock.calls.some(([arg]) => arg.data.status === 'SUCCEEDED')).toBe(false);
  });
  it('keeps legacy success behavior when the additive v3 switch is off', async () => {
    vi.stubEnv('INSPIRATION_SNAPSHOT_V3_ENABLED', 'false');f.taskFind.mockResolvedValueOnce(task());f.sync.mockResolvedValue(undefined);
    worker = createInspirationWorker();await vi.advanceTimersByTimeAsync(1);
    expect(f.taskMany).not.toHaveBeenCalled();
    expect(f.taskUpdate).toHaveBeenCalledWith(expect.objectContaining({data: {status: 'SUCCEEDED', progress: 100, error: null, resultJson: {libraryId: 'synthetic-library'}}}));
  });
  it('does not start remote work when the pending task changed before the claim CAS',async()=>{
    const pending={...task(),updatedAt:now};f.taskFind.mockResolvedValueOnce(pending);
    f.taskUpdate.mockImplementation(async({where,data})=>{
      if(data.status==='RUNNING'&&where.id===pending.id){
        expect(where).toMatchObject({status:'PENDING',updatedAt:pending.updatedAt,expiresAt:pending.expiresAt,inputJson:{equals:pending.inputJson}});
        expect(where.AND[0].expiresAt.gt).toBeInstanceOf(Date);return {count:0};
      }
      return {count:0};
    });
    worker=createInspirationWorker();await vi.advanceTimersByTimeAsync(1);
    expect(f.sync).not.toHaveBeenCalled();expect(f.receiver).not.toHaveBeenCalled();expect(f.taskCurrent).not.toHaveBeenCalled();
  });
  it.each(['failure','success'] as const)('fences a recovered old worker before activation, continuation and late %s',async outcome=>{
    type Stored={id:string;workspaceId:string;inspirationLibraryId:string;status:string;expiresAt:Date;updatedAt:Date;inputJson:SnapshotTaskInput};
    type Where={id?:string;kind?:string;status?:string|{in:string[]};updatedAt?:Date;expiresAt?:Date|{gt?:Date;lte?:Date};inputJson?:{path?:string[];equals?:unknown};AND?:Where[]};
    const row:Stored={...task(),status:'PENDING',updatedAt:new Date()};
    const matches=(where:Where):boolean=>{
      if(where.kind&&where.kind!=='INSPIRATION_SYNC'||where.id&&where.id!==row.id)return false;
      if(where.status&&(typeof where.status==='string'?row.status!==where.status:!where.status.in.includes(row.status)))return false;
      if(where.updatedAt&&where.updatedAt.getTime()!==row.updatedAt.getTime())return false;
      const expiry=where.expiresAt;
      if(expiry instanceof Date&&expiry.getTime()!==row.expiresAt.getTime())return false;
      if(expiry&&!(expiry instanceof Date)&&(expiry.gt&&row.expiresAt<=expiry.gt||expiry.lte&&row.expiresAt>expiry.lte))return false;
      if(where.inputJson){const actual=where.inputJson.path?(row.inputJson as Record<string,unknown>)[where.inputJson.path[0]!]:row.inputJson;if(JSON.stringify(actual)!==JSON.stringify(where.inputJson.equals))return false;}
      return !where.AND||where.AND.every(matches);
    };
    f.taskFind.mockImplementation(async({where}:{where:Where})=>matches(where)?structuredClone(row):null);
    f.taskMany.mockImplementation(async({where}:{where:Where})=>matches(where)?[structuredClone(row)]:[]);
    f.taskCurrent.mockImplementation(async()=>structuredClone(row));
    f.taskUpdate.mockImplementation(async({where,data}:{where:Where;data:Partial<Stored>})=>{if(!matches(where))return {count:0};Object.assign(row,structuredClone(data),{updatedAt:new Date()});return {count:1};});
    let rejectOld!:(error:Error)=>void,resolveOld!:()=>void,resolveNew!:()=>void;
    const oldPending=new Promise<void>((resolve,reject)=>{resolveOld=resolve;rejectOld=reject;});
    const newPending=new Promise<void>(resolve=>{resolveNew=resolve;});
    f.sync.mockImplementationOnce(async(_library,_signal,_recheck,continuation)=>{await continuation.onSession('fixed-session');await oldPending;});
    f.sync.mockImplementationOnce(async(_library,_signal,_recheck,continuation)=>{await continuation.onSession('fixed-session');await newPending;});
    worker=createInspirationWorker();await vi.advanceTimersByTimeAsync(1);
    expect(f.sync).toHaveBeenCalledTimes(1);const oldClaim=row.inputJson.syncClaimId,oldExpiry=row.expiresAt;
    expect(oldClaim).toMatch(/^[a-f0-9-]{36}$/);expect(row.inputJson.snapshotSessionId).toBe('fixed-session');
    // Pause the first process beyond its lease while a second process runs the
    // actual recovery branch and claims the same durable task ID.
    vi.setSystemTime(new Date(oldExpiry.getTime()+1));const second=createInspirationWorker();
    try{
      await vi.advanceTimersByTimeAsync(1);expect(f.sync).toHaveBeenCalledTimes(2);
      const replacement=row.inputJson.syncClaimId;expect(replacement).not.toBe(oldClaim);expect(row.status).toBe('RUNNING');
      const oldRecheck=f.sync.mock.calls[0]![2],oldContinue=f.sync.mock.calls[0]![3].onSession;
      await expect(oldRecheck()).rejects.toBeInstanceOf(InspirationSyncClaimLost);
      await expect(oldContinue('fixed-session')).rejects.toBeInstanceOf(InspirationSyncClaimLost);
      expect(row.inputJson.syncClaimId).toBe(replacement);
      if(outcome==='failure')rejectOld(new Error('late old execution failure'));else resolveOld();
      await vi.advanceTimersByTimeAsync(1);expect(row.status).toBe('RUNNING');expect(row.inputJson.syncClaimId).toBe(replacement);
      const terminal=f.taskUpdate.mock.calls.filter(([call])=>call.where.id===row.id&&['FAILED','SUCCEEDED'].includes(call.data.status));
      expect(terminal.at(-1)![0].where).toMatchObject({expiresAt:oldExpiry,inputJson:{path:['syncClaimId'],equals:oldClaim}});
      await expect(f.sync.mock.calls[1]![2]()).resolves.toBeUndefined();resolveNew();await vi.advanceTimersByTimeAsync(1);
      expect(row.status).toBe('SUCCEEDED');expect(row.inputJson.syncClaimId).toBe(replacement);
    }finally{resolveOld();resolveNew();await second.close();}
  });
});

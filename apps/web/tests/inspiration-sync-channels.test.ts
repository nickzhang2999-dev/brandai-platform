import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
const mocks=vi.hoisted(()=>({upsert:vi.fn(),update:vi.fn(),updateMany:vi.fn(),find:vi.fn(),release:vi.fn(),transaction:vi.fn(),lock:vi.fn()}));
vi.mock('@brandai/db',()=>({prisma:{$transaction:mocks.transaction,inspirationState:{upsert:mocks.upsert,update:mocks.update,updateMany:mocks.updateMany,findUnique:mocks.find},inspirationRelease:{findUnique:mocks.release}}}));
import { applyWithdrawal, syncReplica, syncWithdrawals } from '../src/lib/inspiration/replica';
import { canonical, sha256 } from '../src/lib/inspiration/protocol';
import { CONTENT_SYNC_ERROR, WITHDRAWAL_SYNC_ERROR } from '../src/lib/inspiration/sync-status';

const key=generateKeyPairSync('ed25519'),keys={test:key.publicKey.export({format:'pem',type:'spki'}).toString()};
function signed<T extends object>(value:T){const payload={...value,key_id:'test'};return {...payload,signature:sign(null,Buffer.from(canonical(payload)),key.privateKey).toString('base64')};}
const withdrawal=signed({schema_version:1,sequence:1,created_at:'2026-10-26T00:00:00Z',case_ids:['withdrawn-case']});
let state:Record<string,unknown>;
const response=(value:unknown)=>new Response(JSON.stringify(value),{status:200});
const advance=()=>vi.setSystemTime(Date.now()+1000);
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-26T05:00:00Z'));vi.clearAllMocks();
  state={workspaceId:'ws',activeRelease:null,releaseSequence:0,withdrawalSequence:0,withdrawalHash:null,withdrawn:[],lastSyncAt:null,lastError:null,lastSyncAttemptAt:null,lastSyncFailedAt:null,syncError:null,lastWithdrawalAttemptAt:null,lastWithdrawalAt:null,lastWithdrawalFailedAt:null,withdrawalError:null};
  mocks.upsert.mockImplementation(async({where,update})=>{expect(where.workspaceId).toBe('ws');Object.assign(state,update);return {...state};});
  mocks.find.mockImplementation(async({where})=>{expect(where.workspaceId).toBe('ws');return {...state};});
  mocks.update.mockImplementation(async({where,data})=>{expect(where.workspaceId).toBe('ws');Object.assign(state,data);return {...state};});
  mocks.updateMany.mockImplementation(async({where,data})=>{expect(where.workspaceId).toBe('ws');for(const field of ['lastSyncAttemptAt','lastWithdrawalAttemptAt'])if(where[field] && (state[field] as Date)?.getTime()!==where[field].getTime())return {count:0};Object.assign(state,data);return {count:1};});
  mocks.release.mockResolvedValue(null);
  mocks.transaction.mockImplementation(async(fn)=>fn({$executeRaw:mocks.lock,inspirationState:{upsert:mocks.upsert,update:mocks.update}}));
  vi.stubEnv('INSPIRATION_PUBLISHER_URL','https://publisher.example/knowledge/v1');vi.stubEnv('INSPIRATION_READ_TOKEN','isolated-private-token');vi.stubEnv('INSPIRATION_TRUSTED_KEYS_JSON',JSON.stringify(keys));
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.unstubAllGlobals();});

describe('replica check channel persistence',()=>{
  it('refreshes successful time on an identical signed withdrawal without clearing content errors',async()=>{
    state.syncError=CONTENT_SYNC_ERROR;vi.stubGlobal('fetch',vi.fn(async()=>response({withdrawal})));
    await syncWithdrawals('ws',new AbortController().signal);const first=state.lastWithdrawalAt;
    state.withdrawalError=WITHDRAWAL_SYNC_ERROR;advance();await syncWithdrawals('ws',new AbortController().signal);
    expect((state.lastWithdrawalAt as Date).getTime()).toBeGreaterThan((first as Date).getTime());
    expect(state.withdrawalSequence).toBe(1);expect(state.withdrawalHash).toBe(sha256(canonical(withdrawal)));expect(state.syncError).toBe(CONTENT_SYNC_ERROR);expect(state.withdrawalError).toBeNull();
  });
  it('records no-change and empty content checks as successful without inventing a release',async()=>{
    state.syncError=CONTENT_SYNC_ERROR;state.lastError='legacy';vi.stubGlobal('fetch',vi.fn(async()=>response({status:'empty'})));
    await syncReplica('ws',new AbortController().signal);
    expect(state.lastSyncAt).toEqual(new Date());expect(state.lastWithdrawalAt).toEqual(new Date());expect(state.syncError).toBeNull();expect(state.lastError).toBeNull();expect(state.activeRelease).toBeNull();expect(state.withdrawalHash).toBeNull();
  });
  it('refreshes a known immutable release while leaving any newer independent withdrawal failure visible',async()=>{
    const manifest=signed({schema_version:1,release_id:'r1',sequence:1,kind:'full',parent_release_id:null,created_at:'2026-10-26T00:00:00Z',taxonomy_version:'nova-1',records_count:0,files:[]});
    const raw=JSON.stringify(manifest);state.activeRelease='r1';state.releaseSequence=1;state.syncError=CONTENT_SYNC_ERROR;
    mocks.release.mockImplementation(async()=>{state.withdrawalError=WITHDRAWAL_SYNC_ERROR;state.lastWithdrawalFailedAt=new Date();return {manifestHash:sha256(raw),sequence:1};});
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/withdrawals/latest')?response({status:'empty'}):url.endsWith('/latest')?response({release:{release_id:'r1',sequence:1,manifest_sha256:sha256(raw)}}):new Response(raw)));
    await syncReplica('ws',new AbortController().signal);
    expect(state.syncError).toBeNull();expect(state.lastSyncAt).toEqual(new Date());expect(state.withdrawalError).toBe(WITHDRAWAL_SYNC_ERROR);expect(state.activeRelease).toBe('r1');
  });
  it('does not clear a content failure when the independent withdrawal check recovers',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/withdrawals/latest')?response({status:'empty'}):response({invalid:'private-response'})));
    await expect(syncReplica('ws',new AbortController().signal)).rejects.toThrow();
    expect(state.syncError).toBe(CONTENT_SYNC_ERROR);expect(state.lastSyncFailedAt).toEqual(new Date());expect(state.lastSyncAt).toBeNull();
    advance();await syncWithdrawals('ws',new AbortController().signal);
    expect(state.syncError).toBe(CONTENT_SYNC_ERROR);expect(state.withdrawalError).toBeNull();expect(state.lastWithdrawalAt).toEqual(new Date());
  });
  it('stops content advancement when withdrawals fail, preserving both errors and the old success times',async()=>{
    const old=new Date(Date.now()-60000);state.lastSyncAt=old;state.lastWithdrawalAt=old;state.activeRelease='r1';state.releaseSequence=1;
    const fetchMock=vi.fn(async()=>{throw new Error('private-key-upstream-response');});vi.stubGlobal('fetch',fetchMock);
    await expect(syncReplica('ws',new AbortController().signal)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();expect(state.syncError).toBe(CONTENT_SYNC_ERROR);expect(state.withdrawalError).toBe(WITHDRAWAL_SYNC_ERROR);expect(state.lastSyncAt).toBe(old);expect(state.lastWithdrawalAt).toBe(old);expect(state.activeRelease).toBe('r1');
    expect(JSON.stringify(mocks.updateMany.mock.calls)).not.toContain('private-');
  });
  it('refuses a reset to an unsigned empty withdrawal discovery after an accepted withdrawal',async()=>{
    await applyWithdrawal('ws',Buffer.from(JSON.stringify(withdrawal)),keys);vi.stubGlobal('fetch',vi.fn(async()=>response({status:'empty'})));
    await expect(syncWithdrawals('ws',new AbortController().signal)).rejects.toThrow('rollback');expect(state.withdrawalSequence).toBe(1);expect(state.withdrawn).toEqual(['withdrawn-case']);expect(state.withdrawalError).toBe(WITHDRAWAL_SYNC_ERROR);
  });
  it('refuses empty content discovery after an accepted release',async()=>{
    state.activeRelease='r1';state.releaseSequence=1;vi.stubGlobal('fetch',vi.fn(async()=>response({status:'empty'})));
    await expect(syncReplica('ws',new AbortController().signal)).rejects.toThrow('rollback');expect(state.activeRelease).toBe('r1');expect(state.lastSyncAt).toBeNull();expect(state.syncError).toBe(CONTENT_SYNC_ERROR);
  });
  it('does not let an older successful check erase a newer failed attempt',async()=>{
    let resolveFirst:(value:Response)=>void=()=>{};let calls=0;
    vi.stubGlobal('fetch',vi.fn(()=>{calls++;return calls===1?new Promise<Response>(resolve=>{resolveFirst=resolve;}):Promise.reject(new Error('newer failure'));}));
    const first=syncWithdrawals('ws',new AbortController().signal);
    await vi.waitFor(()=>expect(calls).toBe(1));
    await expect(syncWithdrawals('ws',new AbortController().signal)).rejects.toThrow('newer failure');
    resolveFirst(response({status:'empty'}));await first;
    expect(state.withdrawalError).toBe(WITHDRAWAL_SYNC_ERROR);expect(state.lastWithdrawalAt).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { InspirationListResponse } from '@brandai/contracts';
import { CONTENT_SYNC_ERROR, WITHDRAWAL_SYNC_ERROR, LEGACY_SYNC_ERROR, inspirationSyncStatus } from '../src/lib/inspiration/sync-status';

const now=Date.parse('2026-10-26T05:00:00Z'), recent=new Date(now-30_000), old=new Date(now-11*60_000);
describe('independent inspiration sync status',()=>{
  it('never infers healthy checks from an installed release or a withdrawal hash',()=>{
    const result=inspirationSyncStatus({withdrawalHash:'a'.repeat(64)},'b'.repeat(64),true,true,now);
    expect(result.content.state).toBe('unknown');expect(result.withdrawals.state).toBe('unknown');
    expect(result.activeManifestHash).toBe('b'.repeat(64));expect(result.withdrawalHash).toBe('a'.repeat(64));
  });
  it('reports disabled and unconfigured channels even with recent successful history',()=>{
    const state={lastSyncAt:recent,lastWithdrawalAt:recent};
    expect(inspirationSyncStatus(state,null,false,true,now).content.state).toBe('disabled');
    expect(inspirationSyncStatus(state,null,true,false,now).withdrawals.state).toBe('unconfigured');
  });
  it('uses independent freshness budgets and fails closed for future clock drift',()=>{
    expect(inspirationSyncStatus({lastSyncAt:recent,lastWithdrawalAt:old},null,true,true,now)).toMatchObject({content:{state:'healthy'},withdrawals:{state:'stale'}});
    expect(inspirationSyncStatus({lastSyncAt:old,lastWithdrawalAt:recent},null,true,true,now)).toMatchObject({content:{state:'stale'},withdrawals:{state:'healthy'}});
    expect(inspirationSyncStatus({lastSyncAt:new Date(now+120_000)},null,true,true,now).content.state).toBe('stale');
  });
  it('keeps channel errors separate and never echoes stored diagnostic strings',()=>{
    const result=inspirationSyncStatus({lastSyncAt:recent,lastSyncAttemptAt:recent,lastWithdrawalAt:recent,syncError:'private-token-url',withdrawalError:'private-key'},null,true,true,now);
    expect(result.content).toMatchObject({state:'error',error:CONTENT_SYNC_ERROR});expect(result.withdrawals).toMatchObject({state:'error',error:WITHDRAWAL_SYNC_ERROR});
    expect(JSON.stringify(result)).not.toContain('private-');
  });
  it('marks old shared errors as historical and does not invent their channel provenance',()=>{
    const result=inspirationSyncStatus({lastSyncAt:recent,lastError:'private-old-error'},null,true,true,now);
    expect(result.content.error).toBe(LEGACY_SYNC_ERROR);expect(result.withdrawals.state).toBe('unknown');
    expect(inspirationSyncStatus({lastSyncAt:recent,lastSyncAttemptAt:recent,lastError:'old'},null,true,true,now).content.error).toBe(LEGACY_SYNC_ERROR);
    expect(inspirationSyncStatus({lastSyncAt:recent,lastSyncAttemptAt:recent,lastError:null},null,true,true,now).content.error).toBeNull();
  });
  it('preserves nullable fields and accepts old list responses without pretending status exists',()=>{
    const list={enabled:true,syncConfigured:true,activeRelease:null,caseCount:0,withdrawalSequence:0,lastSyncAt:null,error:null,cases:[],searchMode:'keyword-tags'};
    expect(InspirationListResponse.parse(list).syncStatus).toBeUndefined();
    expect(InspirationListResponse.safeParse({...list,syncStatus:null}).success).toBe(false);
    const status=inspirationSyncStatus(null,null,true,true,now);
    expect(InspirationListResponse.parse({...list,syncStatus:status}).syncStatus?.content.lastFailureAt).toBeNull();
    expect(InspirationListResponse.safeParse({...list,syncStatus:{...status,activeManifestHash:'not-a-hash'}}).success).toBe(false);
  });
});

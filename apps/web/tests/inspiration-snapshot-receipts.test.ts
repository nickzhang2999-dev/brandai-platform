import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Prisma} from '@brandai/db';
const db=vi.hoisted(()=>({inspirationDailyPolicy:{findUnique:vi.fn(),update:vi.fn()},inspirationState:{findUnique:vi.fn()},inspirationImageReceipt:{findMany:vi.fn(),count:vi.fn(),createMany:vi.fn()},$executeRaw:vi.fn(),$transaction:vi.fn()}));
vi.mock('@brandai/db',()=>({prisma:db}));
import {DailyReceiptLimit,promoteDailyTarget,recordSnapshotDailyReceipt,dailyReceiptStatus} from '../src/lib/inspiration/daily-receipts';
const now=new Date('2026-11-06T10:00:00Z'),tx=db as unknown as Prisma.TransactionClient;
const hashes=(count:number)=>Array.from({length:count},(_,i)=>i.toString(16).padStart(64,'0'));
const input={ownerId:'synthetic-owner',libraryId:'synthetic-library',releaseId:'synthetic-root',hashes:hashes(501),target:500};
beforeEach(()=>{vi.resetAllMocks();db.$transaction.mockImplementation(async(fn:(tx:unknown)=>unknown)=>fn(db));db.inspirationImageReceipt.findMany.mockResolvedValue([]);db.inspirationImageReceipt.count.mockResolvedValue(0);db.inspirationState.findUnique.mockResolvedValue({activeRelease:null});});
afterEach(()=>vi.unstubAllEnvs());
describe('500-image receipt and explicit first snapshot initialization',()=>{
  it('promotes only a completed reviewed 400 day to 500, and never to 600',async()=>{
    db.inspirationDailyPolicy.findUnique.mockResolvedValue({target:400,startDay:'2026-11-01',qualityDay:'2026-11-04'});db.inspirationImageReceipt.count.mockResolvedValue(400);
    await promoteDailyTarget('synthetic-owner','2026-11-05','synthetic quality evidence','synthetic-admin',now);
    expect(db.inspirationDailyPolicy.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({target:500})}));
    db.inspirationDailyPolicy.findUnique.mockResolvedValue({target:500});
    await expect(promoteDailyTarget('synthetic-owner','2026-11-05','synthetic quality evidence','synthetic-admin',now)).rejects.toThrow('不可升档');
  });
  it('requires whole-package daily capacity unless initialization is explicitly scoped',async()=>{
    await expect(recordSnapshotDailyReceipt(tx,input,now)).rejects.toBeInstanceOf(DailyReceiptLimit);
    expect(db.inspirationImageReceipt.createMany).not.toHaveBeenCalled();
    const result=await recordSnapshotDailyReceipt(tx,{...input,hashes:hashes(500)},now);
    expect(result).toMatchObject({newly_received:500,received:500,remaining:0});
  });
  it.each([
    {ownerId:'different-owner'}, {libraryId:'different-library'}, {releaseId:'different-root'},
  ])('does not widen a mismatched or oversized bootstrap policy %j',async patch=>{
    vi.stubEnv('INSPIRATION_SNAPSHOT_BOOTSTRAP',JSON.stringify({...input,hashes:undefined,target:undefined,maxImages:1000,...patch}));
    await expect(recordSnapshotDailyReceipt(tx,input,now)).rejects.toBeInstanceOf(DailyReceiptLimit);
    expect(db.inspirationImageReceipt.createMany).not.toHaveBeenCalled();
  });
  it.each([{maxImages:500,error:'snapshot_initialization_image_limit'},{maxImages:1_000_001,error:'invalid_snapshot_initialization_policy'},{maxImages:'1000',error:'invalid_snapshot_initialization_policy'},{extra:true,error:'invalid_snapshot_initialization_policy'}])('rejects bootstrap bounds or malformed fields %j',async ({error,...patch})=>{
    vi.stubEnv('INSPIRATION_SNAPSHOT_BOOTSTRAP',JSON.stringify({ownerId:input.ownerId,libraryId:input.libraryId,releaseId:input.releaseId,maxImages:1000,...patch}));
    await expect(recordSnapshotDailyReceipt(tx,input,now)).rejects.toThrow(error);expect(db.inspirationImageReceipt.createMany).not.toHaveBeenCalled();
  });
  it('accounts for a small explicitly scoped history import as initialization even below 500',async()=>{
    vi.stubEnv('INSPIRATION_SNAPSHOT_BOOTSTRAP',JSON.stringify({ownerId:input.ownerId,libraryId:input.libraryId,releaseId:input.releaseId,maxImages:3}));
    expect(await recordSnapshotDailyReceipt(tx,{...input,hashes:hashes(3)},now)).toMatchObject({initialized:3,newly_received:0,received:0,remaining:500});
    expect(db.inspirationImageReceipt.createMany.mock.calls[0]![0].data.every((row:{receivedDay:unknown})=>row.receivedDay===null)).toBe(true);
  });
  it.each([{ownerId:null},{ownerId:17},{libraryId:''},{libraryId:['synthetic-library']},{releaseId:false},{releaseId:'../outside'},{releaseId:'x'.repeat(129)}])('fails closed on malformed bootstrap identity even below daily allowance %j',async patch=>{
    vi.stubEnv('INSPIRATION_SNAPSHOT_BOOTSTRAP',JSON.stringify({ownerId:input.ownerId,libraryId:input.libraryId,releaseId:input.releaseId,maxImages:3,...patch}));
    await expect(recordSnapshotDailyReceipt(tx,{...input,hashes:hashes(1)},now)).rejects.toThrow('invalid_snapshot_initialization_policy');
    expect(db.inspirationImageReceipt.createMany).not.toHaveBeenCalled();
  });
  it('deduplicates the same owner history across libraries without reassigning old receipts',async()=>{
    vi.stubEnv('INSPIRATION_SNAPSHOT_BOOTSTRAP',JSON.stringify({ownerId:input.ownerId,libraryId:input.libraryId,releaseId:input.releaseId,maxImages:3}));
    db.inspirationImageReceipt.findMany.mockResolvedValue([{sha256:hashes(1)[0]}]);
    expect(await recordSnapshotDailyReceipt(tx,{...input,hashes:hashes(3)},now)).toMatchObject({initialized:2,newly_received:0});
    expect(db.inspirationImageReceipt.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{ownerId:input.ownerId,sha256:{in:hashes(3)}}}));
    expect(db.inspirationImageReceipt.createMany.mock.calls[0]![0].data).toHaveLength(2);
  });
  it('keeps initialization separate from daily gains and batches SQL writes',async()=>{
    vi.stubEnv('INSPIRATION_SNAPSHOT_BOOTSTRAP',JSON.stringify({ownerId:input.ownerId,libraryId:input.libraryId,releaseId:input.releaseId,maxImages:2500}));
    const result=await recordSnapshotDailyReceipt(tx,{...input,hashes:hashes(2500)},now);
    expect(result).toMatchObject({newly_received:0,received:0,remaining:500,initialized:2500});
    expect(db.inspirationImageReceipt.createMany.mock.calls.map(([arg])=>arg.data.length)).toEqual([1000,1000,500]);
    expect(db.inspirationImageReceipt.createMany.mock.calls[0]![0].data[0]).toMatchObject({receivedDay:null,receivedAt:now,initializationId:'synthetic-library:synthetic-root'});
  });
  it('cannot use first-import authorization to bypass daily quota in an existing library',async()=>{
    vi.stubEnv('INSPIRATION_SNAPSHOT_BOOTSTRAP',JSON.stringify({ownerId:input.ownerId,libraryId:input.libraryId,releaseId:input.releaseId,maxImages:1000}));
    db.inspirationState.findUnique.mockResolvedValue({activeRelease:'installed-version'});
    await expect(recordSnapshotDailyReceipt(tx,input,now)).rejects.toBeInstanceOf(DailyReceiptLimit);
    expect(db.inspirationImageReceipt.createMany).not.toHaveBeenCalled();
  });
  it('reports old baseline and explicit initialization separately',async()=>{
    db.inspirationDailyPolicy.findUnique.mockResolvedValue(null);
    await dailyReceiptStatus('synthetic-owner');
    expect(db.inspirationImageReceipt.count).toHaveBeenCalledWith({where:{ownerId:'synthetic-owner',receivedDay:null,initializationId:null}});
    expect(db.inspirationImageReceipt.count).toHaveBeenCalledWith({where:{ownerId:'synthetic-owner',initializationId:{not:null}}});
  });
});

import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Prisma} from '@brandai/db';
const db=vi.hoisted(()=>({inspirationDailyPolicy:{findUnique:vi.fn(),update:vi.fn()},inspirationImageReceipt:{findMany:vi.fn(),count:vi.fn(),createMany:vi.fn()},user:{findUnique:vi.fn()},$executeRaw:vi.fn(),$transaction:vi.fn()}));
vi.mock('@brandai/db',()=>({prisma:db}));
vi.mock('@/lib/api',()=>({ApiException:class extends Error {constructor(public status:number,message:string){super(message);}}}));
import {chinaDay,validDay,recordDailyReceipt,DailyReceiptLimit,promoteDailyTarget,dailyReceiptStatus,dailyReceiptsEnabled,preflightDailyReceipt} from '../src/lib/inspiration/daily-receipts';
import {authenticateReceiptReader,readReceiptJson} from '../src/lib/inspiration/receipt-auth';
import {createHash} from 'node:crypto';
const a='a'.repeat(64),b='b'.repeat(64),tx=db as unknown as Prisma.TransactionClient;
beforeEach(()=>{vi.clearAllMocks();db.$transaction.mockImplementation(async(fn:(arg:unknown)=>unknown)=>fn(db));});
afterEach(()=>vi.unstubAllEnvs());
describe('successful image receipt accounting',()=>{
  it('enables only the explicit company owner and reads preflight in one repeatable snapshot',async()=>{
    vi.stubEnv('INSPIRATION_DAILY_RECEIPTS_ENABLED','true');vi.stubEnv('INSPIRATION_RECEIPT_OWNER_ID','company');
    expect(dailyReceiptsEnabled('company')).toBe(true);expect(dailyReceiptsEnabled('other')).toBe(false);
    db.inspirationDailyPolicy.findUnique.mockResolvedValue(null);db.inspirationImageReceipt.count.mockResolvedValue(0);db.inspirationImageReceipt.findMany.mockResolvedValue([]);
    await preflightDailyReceipt('company',[a]);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function),{isolationLevel:'RepeatableRead',timeout:5000});
  });
  it('uses China midnight, rejecting impossible dates',()=>{
    expect(chinaDay(new Date('2026-11-05T15:59:59Z'))).toBe('2026-11-05');
    expect(chinaDay(new Date('2026-11-05T16:00:00Z'))).toBe('2026-11-06');
    expect(validDay('2026-02-30')).toBe(false);expect(validDay('2026-02-28')).toBe(true);
  });
  it('counts a repeated hash once and excludes hashes already received on any day/source/library',async()=>{
    db.inspirationImageReceipt.findMany.mockResolvedValue([{sha256:a}]);db.inspirationImageReceipt.count.mockResolvedValue(99);
    const receipt=await recordDailyReceipt(tx,{ownerId:'owner',libraryId:'library2',releaseId:'new',hashes:[a,b,b],target:100},new Date('2026-11-05T16:00:00Z'));
    expect(receipt).toEqual({day:'2026-11-06',newly_received:1,received:100,remaining:0});
    expect(db.inspirationImageReceipt.createMany.mock.calls[0]![0].data).toHaveLength(1);
    expect(db.inspirationImageReceipt.count).toHaveBeenCalledWith({where:{ownerId:'owner',receivedDay:'2026-11-06'}});
  });
  it('rejects the entire new batch before creating any receipt, but accepts only-known revisions at the cap',async()=>{
    db.inspirationImageReceipt.findMany.mockResolvedValue([]);db.inspirationImageReceipt.count.mockResolvedValue(99);
    const input={ownerId:'owner',libraryId:'library',releaseId:'new',hashes:[a,b],target:100};
    await expect(recordDailyReceipt(tx,input)).rejects.toBeInstanceOf(DailyReceiptLimit);
    expect(db.inspirationImageReceipt.createMany).not.toHaveBeenCalled();
    db.inspirationImageReceipt.findMany.mockResolvedValue([{sha256:a},{sha256:b}]);db.inspirationImageReceipt.count.mockResolvedValue(100);
    expect((await recordDailyReceipt(tx,input)).newly_received).toBe(0);
  });
  it('never promotes without a finished day, achieved volume and a fresh quality review',async()=>{
    const now=new Date('2026-11-06T10:00:00Z');db.inspirationDailyPolicy.findUnique.mockResolvedValue({target:100,startDay:'2026-11-05',qualityDay:null});
    await expect(promoteDailyTarget('owner','2026-11-06','review evidence','admin',now)).rejects.toThrow('已结束');
    db.inspirationImageReceipt.count.mockResolvedValue(99);await expect(promoteDailyTarget('owner','2026-11-05','review evidence','admin',now)).rejects.toThrow('尚未');
    db.inspirationImageReceipt.count.mockResolvedValue(100);await promoteDailyTarget('owner','2026-11-05','review evidence','admin',now);
    expect(db.inspirationDailyPolicy.update.mock.calls[0]![0].data).toMatchObject({target:200,qualityDay:'2026-11-05',qualityReviewedBy:'admin'});
    db.inspirationDailyPolicy.findUnique.mockResolvedValue({target:200,startDay:'2026-11-05',qualityDay:'2026-11-05'});
    await expect(promoteDailyTarget('owner','2026-11-05','review evidence','admin',now)).rejects.toThrow('新的');
  });
  it('does not invent historical targets or human review',async()=>{
    db.inspirationDailyPolicy.findUnique.mockResolvedValue({target:200,startedAt:new Date('2026-11-01T00:00:00Z'),startDay:'2026-11-01'});
    db.inspirationImageReceipt.count.mockResolvedValue(0);
    expect(await dailyReceiptStatus('owner','2026-11-01')).toMatchObject({target:null,human_reviewed:null,received:0});
  });
});
describe('independent receipt credential and input limits',()=>{
  it('denies missing, wrong and inactive-owner credentials',async()=>{
    await expect(authenticateReceiptReader(new Request('https://example.invalid'))).rejects.toThrow('not_configured');
    const token='unit-test-token-not-a-real-secret-1234567890';vi.stubEnv('INSPIRATION_RECEIPT_TOKEN_SHA256',createHash('sha256').update(token).digest('hex'));vi.stubEnv('INSPIRATION_RECEIPT_OWNER_ID','owner');
    await expect(authenticateReceiptReader(new Request('https://example.invalid',{headers:{Authorization:'Bearer '+'x'.repeat(40)}}))).rejects.toThrow('unauthorized');
    const req=new Request('https://example.invalid',{headers:{Authorization:'Bearer '+token}});db.user.findUnique.mockResolvedValue({isActive:false});
    await expect(authenticateReceiptReader(req)).rejects.toThrow('inactive');db.user.findUnique.mockResolvedValue({isActive:true});expect(await authenticateReceiptReader(req)).toBe('owner');
  });
  it('enforces body bytes even without content-length',async()=>{
    const req=new Request('https://example.invalid',{method:'POST',body:'x'.repeat(80_001)});
    await expect(readReceiptJson(req)).rejects.toThrow('too_large');
    await expect(readReceiptJson(new Request('https://example.invalid',{method:'POST',body:'bad'}))).rejects.toThrow('invalid_json');
  });
});

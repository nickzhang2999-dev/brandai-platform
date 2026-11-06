import { prisma, type Prisma } from '@brandai/db';
type Tx = Prisma.TransactionClient;
export class DailyReceiptError extends Error { constructor(public status:number,message:string){super(message);} }

export const dailyReceiptsEnabled = (ownerId?:string) => process.env.INSPIRATION_DAILY_RECEIPTS_ENABLED === 'true'
  && !!process.env.INSPIRATION_RECEIPT_OWNER_ID && (ownerId===undefined || ownerId===process.env.INSPIRATION_RECEIPT_OWNER_ID);
export const chinaDay = (now = new Date()) => new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
export function validDay(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
}
export async function lockReceiptOwner(tx: Tx, ownerId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inspiration-receipts:${ownerId}`}))`;
}
export class DailyReceiptLimit extends Error {
  constructor(public needed: number, public remaining: number) { super('daily_image_budget_exceeded_package_deferred'); }
}
const RECEIPT_TARGETS = [100, 200, 300, 400, 500] as const;
type ReceiptInput = {ownerId:string;libraryId:string;releaseId:string;hashes:string[];target:number};
async function freshReceiptHashes(tx:Tx,ownerId:string,input:string[]) {
  const hashes=[...new Set(input)];
  if(hashes.length>1_000_000||hashes.some(hash=>! /^[a-f0-9]{64}$/.test(hash)))throw new Error('invalid_receipt_image_hashes');
  const known=new Set<string>();
  for(let start=0;start<hashes.length;start+=1000) {
    const rows=await tx.inspirationImageReceipt.findMany({where:{ownerId,sha256:{in:hashes.slice(start,start+1000)}},select:{sha256:true}});
    rows.forEach(row=>known.add(row.sha256));
  }
  return hashes.filter(hash=>!known.has(hash));
}
/** Existing files are baseline, including withdrawn history; never invent their arrival date. */
export async function baselineExistingImages(tx: Tx, ownerId: string) {
  await tx.$executeRaw`
    INSERT INTO "InspirationImageReceipt" ("ownerId", "sha256")
    SELECT DISTINCT ${ownerId}, i."sha256" FROM "InspirationLibraryImage" i
    JOIN "InspirationLibrary" l ON l."id" = i."libraryId"
    WHERE l."ownerId" = ${ownerId}
    ON CONFLICT ("ownerId", "sha256") DO NOTHING`;
}
export async function initializeDailyPolicy(ownerId: string, now = new Date()) {
  return prisma.$transaction(async tx => {
    await lockReceiptOwner(tx, ownerId);
    const owner = await tx.user.findUnique({where:{id:ownerId}, select:{isActive:true}});
    if (!owner?.isActive) throw new DailyReceiptError(404, '公司所有者不可用。');
    await baselineExistingImages(tx, ownerId);
    return tx.inspirationDailyPolicy.upsert({where:{ownerId}, update:{}, create:{ownerId, startDay:chinaDay(now), startedAt:now, target:100}});
  });
}
/** Called before writes while holding the owner lock; tracking must be explicitly initialized. */
export async function beginDailyReceipt(tx: Tx, ownerId: string) {
  await lockReceiptOwner(tx, ownerId);
  const policy = await tx.inspirationDailyPolicy.findUnique({where:{ownerId}});
  if (!policy) throw new Error('daily_image_receipts_not_initialized');
  // Also accounts for content imported while tracking was disabled, without claiming historical gains.
  await baselineExistingImages(tx, ownerId);
  return policy;
}
/** Runs in the same transaction as image bytes, release and active snapshot. Rollbacks leave no receipts. */
export async function recordDailyReceipt(tx: Tx, input: ReceiptInput, now = new Date()) {
  if(!RECEIPT_TARGETS.includes(input.target as typeof RECEIPT_TARGETS[number]))throw new Error('invalid_daily_receipt_target');
  const day = chinaDay(now), fresh=await freshReceiptHashes(tx,input.ownerId,input.hashes);
  const received = await tx.inspirationImageReceipt.count({where:{ownerId:input.ownerId,receivedDay:day}});
  const remaining=Math.max(0,input.target-received);
  if(fresh.length>remaining)throw new DailyReceiptLimit(fresh.length,remaining);
  for(let start=0;start<fresh.length;start+=1000)await tx.inspirationImageReceipt.createMany({data:fresh.slice(start,start+1000).map(sha256=>({ownerId:input.ownerId,sha256,receivedDay:day,receivedAt:now,libraryId:input.libraryId,releaseId:input.releaseId}))});
  return {day, newly_received:fresh.length, received:received+fresh.length, remaining:remaining-fresh.length};
}
/** Only an explicitly named, bounded first import may be recorded separately
 * from daily gains. Pending CAS bytes never qualify as historical baseline. */
export async function recordSnapshotDailyReceipt(tx:Tx,input:ReceiptInput,now=new Date()) {
  try { return await recordDailyReceipt(tx,input,now); }
  catch(error) {
    if(!(error instanceof DailyReceiptLimit))throw error;
    const raw=process.env.INSPIRATION_SNAPSHOT_BOOTSTRAP?.trim();
    if(!raw)throw error;
    let policy:unknown;try {policy=JSON.parse(raw);}catch{throw new Error('invalid_snapshot_initialization_policy');}
    const p=policy as Record<string,unknown>;
    if(!p||Array.isArray(p)||Object.keys(p).sort().join(',')!=='libraryId,maxImages,ownerId,releaseId'
      ||p.ownerId!==input.ownerId||p.libraryId!==input.libraryId||p.releaseId!==input.releaseId
      ||!Number.isInteger(p.maxImages)||Number(p.maxImages)<1||Number(p.maxImages)>1_000_000)throw error;
    const state=await tx.inspirationState.findUnique({where:{libraryId:input.libraryId},select:{activeRelease:true}});
    if(state?.activeRelease)throw error;
    const fresh=await freshReceiptHashes(tx,input.ownerId,input.hashes);
    if(fresh.length>Number(p.maxImages))throw error;
    const initializationId=`${input.libraryId}:${input.releaseId}`;
    for(let start=0;start<fresh.length;start+=1000)await tx.inspirationImageReceipt.createMany({data:fresh.slice(start,start+1000).map(sha256=>({ownerId:input.ownerId,sha256,receivedDay:null,receivedAt:now,libraryId:input.libraryId,releaseId:input.releaseId,initializationId}))});
    const received=await tx.inspirationImageReceipt.count({where:{ownerId:input.ownerId,receivedDay:chinaDay(now)}});
    return {day:chinaDay(now),newly_received:0,received,remaining:Math.max(0,input.target-received),initialized:fresh.length};
  }
}
async function readDailyReceiptStatus(db:Tx,ownerId: string, day=chinaDay()) {
  if(!validDay(day)||day>chinaDay())throw new DailyReceiptError(400,'日报日期无效。');
  const [policy,received,baselineCount,totalCount,initializedCount] = await Promise.all([
    db.inspirationDailyPolicy.findUnique({where:{ownerId}}),
    db.inspirationImageReceipt.count({where:{ownerId,receivedDay:day}}),
    db.inspirationImageReceipt.count({where:{ownerId,receivedDay:null,initializationId:null}}),
    db.inspirationImageReceipt.count({where:{ownerId}}),
    db.inspirationImageReceipt.count({where:{ownerId,initializationId:{not:null}}}),
  ]);
  if(policy&&day<policy.startDay)throw new DailyReceiptError(409,'该日期早于新增图片计量启用日，历史接收数未知。');
  // Historical target is unknown after a promotion; do not silently apply today's target to past days.
  const target=policy && day===chinaDay()?policy.target:null;
  return {schema_version:1, timezone:'Asia/Shanghai', day, enabled:dailyReceiptsEnabled(ownerId), initialized:!!policy,
    started_at:policy?.startedAt.toISOString()??null,start_day:policy?.startDay??null,
    metric:'first_successful_unique_image_sha256', received, target, remaining:target===null?null:Math.max(0,target-received),
    baseline_count:baselineCount, initialized_count:initializedCount, receipt_revision:policy?`${policy.startedAt.toISOString()}:${totalCount}`:null,
    baseline_revision:policy?`${policy.startedAt.toISOString()}:${baselineCount}`:null,
    human_reviewed:null, quality_review:policy?.qualityDay?{day:policy.qualityDay,reviewed_at:policy.qualityReviewedAt?.toISOString()??null}:null,
    notice:'接收数表示首次成功入库；不代表人工审核完成，也不保证之后未被撤回。历史目标未归档时显示未知。'};
}
export async function dailyReceiptStatus(ownerId:string,day=chinaDay()) {
  return prisma.$transaction(tx=>readDailyReceiptStatus(tx,ownerId,day),{isolationLevel:'RepeatableRead',timeout:5000});
}
export async function preflightDailyReceipt(ownerId:string, hashes:string[]) {
  return prisma.$transaction(async tx=>{
    const status=await readDailyReceiptStatus(tx,ownerId),unique=[...new Set(hashes)];
    const seen=await tx.inspirationImageReceipt.findMany({where:{ownerId,sha256:{in:unique}},select:{sha256:true}});
    const known=seen.map(row=>row.sha256), fresh=unique.length-known.length;
    return {...status,known_sha256:known,new_unique_images:fresh, fits:status.enabled&&status.initialized&&status.remaining!==null&&fresh<=status.remaining,
      advisory:true, atomic_package_required:true};
  },{isolationLevel:'RepeatableRead',timeout:5000});
}
export async function promoteDailyTarget(ownerId:string, qualityDay:string, evidence:string, reviewerId:string, now=new Date()) {
  if(!validDay(qualityDay)||qualityDay>=chinaDay(now))throw new DailyReceiptError(400,'请审核已结束的北京时间日期。');
  return prisma.$transaction(async tx=>{
    await lockReceiptOwner(tx,ownerId);
    const policy=await tx.inspirationDailyPolicy.findUnique({where:{ownerId}});
    if(!policy||!RECEIPT_TARGETS.includes(policy.target as typeof RECEIPT_TARGETS[number])||policy.target>=500)throw new DailyReceiptError(409,'当前目标不可升档。');
    if(qualityDay<policy.startDay||(policy.qualityDay&&qualityDay<=policy.qualityDay))throw new DailyReceiptError(409,'需要本阶段新的质量审核记录。');
    const received=await tx.inspirationImageReceipt.count({where:{ownerId,receivedDay:qualityDay}});
    if(received<policy.target)throw new DailyReceiptError(409,'该日实际新增图片尚未达到当前目标。');
    return tx.inspirationDailyPolicy.update({where:{ownerId},data:{target:policy.target+100,qualityDay,qualityEvidence:evidence,qualityReviewedBy:reviewerId,qualityReviewedAt:now}});
  });
}

import {Prisma,prisma} from '@brandai/db';
import {receiverOrigin} from './config';
import type {LibraryScope} from './library-scope';
import {LibraryRecipient} from './publication-scope';
import {CATALOG_MAX_PAGE_SIZE,CATALOG_PAGE_SIZE,type CatalogFilters,type CatalogPage} from './catalog';

export function isSnapshotRelease(release:{manifest:unknown;snapshot?:unknown}|null|undefined) {
  return !!release && typeof release.manifest==='object' && release.manifest!==null
    && (release.manifest as {schema_version?:number}).schema_version===3;
}
export function assertSnapshotReadScope(release:{manifest:unknown},library:LibraryScope) {
  const recipient=LibraryRecipient.parse((release.manifest as {recipient?:unknown}).recipient);
  if(library.kind!=='SHARED'||recipient.library_id!==library.id||recipient.origin!==receiverOrigin())throw new Error('Publication recipient mismatch');
}
/** Same whole-word/bigram rule as the legacy scorer, evaluated before SQL paging. */
export function snapshotScoreSql(query:string):Prisma.Sql {
  const words=query.trim().toLocaleLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]+/gu)??[];
  const scores=words.map(word=>{
    if(!/[\u3400-\u9fff]/u.test(word)||word.length<=2)return Prisma.sql`CASE WHEN strpos(e."searchText",${word})>0 THEN ${word.length*2} ELSE 0 END`;
    const bigrams=[...new Set(Array.from({length:word.length-1},(_,i)=>word.slice(i,i+2)))];
    const hits=bigrams.map(term=>Prisma.sql`CASE WHEN strpos(e."searchText",${term})>0 THEN 1 ELSE 0 END`);
    const sum=Prisma.join(hits,' + ');
    return Prisma.sql`CASE WHEN strpos(e."searchText",${word})>0 THEN ${word.length*2} WHEN (${sum})>=2 THEN (${sum})*2 ELSE 0 END`;
  });
  return scores.length?Prisma.sql`(${Prisma.join(scores,' + ')})`:Prisma.sql`0`;
}
/** Only the selected page's record bodies enter JS; all history stays in SQL. */
export async function snapshotCatalogPage(libraryId:string,releaseId:string,filters:CatalogFilters={},page:CatalogPage={},options:{analysisOnly?:boolean}={}) {
  const rawSize=page.limit??CATALOG_PAGE_SIZE;
  const size=Number.isFinite(rawSize)?Math.min(Math.max(Math.trunc(rawSize),1),CATALOG_MAX_PAGE_SIZE):CATALOG_PAGE_SIZE;
  const query=filters.q?.trim()??'',cursor=page.cursor?.trim()||null;
  if(query.length>500||cursor&&cursor.length>128)throw new Error('Invalid snapshot catalog query');
  const score=snapshotScoreSql(query);
  const base=Prisma.sql`FROM "InspirationSnapshotReleasePart" p
    JOIN "InspirationSnapshotCatalogEntry" e USING("libraryId","partHash")
    JOIN "InspirationLibraryRecord" r ON r.id=e."recordId" AND r."libraryId"=e."libraryId"
    JOIN "InspirationLibraryState" s ON s."libraryId"=p."libraryId"
    WHERE p."libraryId"=${libraryId} AND p."releaseId"=${releaseId}
      AND r.deleted=false AND r.body->>'display_permission'='allowed'
      AND NOT (s.withdrawn ? e."caseId")
      ${options.analysisOnly?Prisma.sql`AND r.body->'permissions'->>'analysis'='allowed'
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements((r.body->'sources')||(r.body->'images')) entity
          WHERE entity->'permissions'->>'analysis' IS DISTINCT FROM 'allowed')`:Prisma.empty}`;
  const filtersSql=Prisma.sql`${filters.kind?Prisma.sql`AND e."contentType"=${filters.kind}`:Prisma.empty}
    ${filters.industry?Prisma.sql`AND ${filters.industry}=ANY(e.industry)`:Prisma.empty}
    ${filters.medium?Prisma.sql`AND ${filters.medium}=ANY(e.medium)`:Prisma.empty}
    ${filters.task?Prisma.sql`AND ${filters.task}=ANY(e.task)`:Prisma.empty}`;
  const candidates=Prisma.sql`SELECT e."caseId",r.id,${score} AS score ${base} ${filtersSql}`;
  const matched=Prisma.sql`SELECT * FROM candidates ${query?Prisma.sql`WHERE score>0`:Prisma.empty}`;
  // A repeatable-read page pins counts, cursor and current withdrawals together.
  return prisma.$transaction(async tx=>{
    const [totals]=await tx.$queryRaw<Array<{count:bigint}>>`SELECT count(*) AS count ${base}`;
    const [counts]=await tx.$queryRaw<Array<{count:bigint}>>`WITH candidates AS (${candidates}), matched AS (${matched}) SELECT count(*) AS count FROM matched`;
    const rows=await tx.$queryRaw<Array<{id:string;caseId:string}>>`WITH candidates AS (${candidates}), matched AS (${matched})
      SELECT id,"caseId" FROM matched
      ${cursor?Prisma.sql`WHERE EXISTS(SELECT 1 FROM matched WHERE "caseId"=${cursor}) AND
        (score<(SELECT score FROM matched WHERE "caseId"=${cursor}) OR
         (score=(SELECT score FROM matched WHERE "caseId"=${cursor}) AND "caseId" COLLATE "C">${cursor} COLLATE "C"))`:Prisma.empty}
      ORDER BY score DESC,"caseId" COLLATE "C" ASC LIMIT ${size+1}`;
    const selected=rows.slice(0,size),hasMore=rows.length>size;
    const records=selected.length?await tx.inspirationRecord.findMany({where:{libraryId,id:{in:selected.map(row=>row.id)},deleted:false}}):[];
    const byId=new Map(records.map(row=>[row.id,row]));
    return {records:selected.flatMap(row=>byId.has(row.id)?[byId.get(row.id)!]:[]),caseCount:Number(totals?.count??0),matchedCount:Number(counts?.count??0),hasMore,nextCursor:hasMore?selected.at(-1)!.caseId:null};
  },{isolationLevel:'RepeatableRead',timeout:10000});
}

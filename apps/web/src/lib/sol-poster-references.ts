import { prisma, type Prisma } from "@brandai/db";
import { SolReferenceKey, SolReferenceSearch, type SolReferenceCard, type InspirationCaseCard } from "@brandai/contracts";
import { z } from "zod";
import { hashStudioPayload } from "./studio-generation-policy";
import { currentCases, keywordScore } from "./inspiration/service";
import { ApiException } from "./api";

export const PosterSources = z.object({
  search: SolReferenceSearch, candidates: z.array(SolReferenceKey).max(6),
  selected: SolReferenceKey.nullable(), currentOnly: z.boolean(),
});
export type PosterSources = z.infer<typeof PosterSources>;
type Db = Pick<Prisma.TransactionClient,"project">;
const projectFields = (workspaceId: string) => ({
  id:true, name:true, campaign:true, startDate:true, endDate:true, tags:true,
  assetLinks:{where:{kind:"REFERENCE",asset:{workspaceId,availableForGeneration:true,deprecatedAt:null,mimeType:{in:["image/png","image/jpeg","image/webp"] as string[]}}},
    select:{assetId:true,updatedAt:true,asset:{select:{storageKey:true,sizeBytes:true,generationVersionId:true,studioUploads:{select:{sha256:true},orderBy:{taskId:"asc"},take:1}}}},orderBy:{id:"asc" as const},take:1},
} as const);
type Campaign = Prisma.ProjectGetPayload<{select:ReturnType<typeof projectFields>}>;
const encode = encodeURIComponent;

function campaignCard(ws:string, p:Campaign):SolReferenceCard {
  const a=p.assetLinks[0];
  return {kind:"campaign",id:p.id,version:hashStudioPayload(p),title:p.name,style:p.tags.slice(0,8).map(t=>t.slice(0,100)),
    date:p.startDate?.toISOString().slice(0,10) ?? null,url:"/studio-editor?surface=canvas&workspaceId="+encode(ws)+"&projectId="+encode(p.id),
    thumbnail:a ? "/api/workspaces/"+encode(ws)+"/assets/"+encode(a.assetId)+"/raw" : null};
}
function inspirationCard(ws:string,c:InspirationCaseCard):SolReferenceCard {
  return {kind:"inspiration",id:c.caseId,libraryId:c.libraryId,version:hashStudioPayload([c.libraryId,c.caseId,c.revision]),
    title:c.title, date:null,style:Object.values(c.tags).flat().slice(0,8).map(t=>t.slice(0,100)),
    url:"/inspiration?workspaceId="+encode(ws)+"&q="+encode(c.title)+"&caseId="+encode(c.caseId)+"&libraryId="+encode(c.libraryId??ws),
    thumbnail:c.images[0]?.url??null};
}
export function asSourceKey(c:SolReferenceCard){return SolReferenceKey.parse({kind:c.kind,id:c.id,libraryId:c.libraryId,version:c.version});}
export function sameSource(a:z.infer<typeof SolReferenceKey>,b:z.infer<typeof SolReferenceKey>){
  return a.kind===b.kind && a.id===b.id && a.libraryId===b.libraryId && a.version===b.version;
}
// The caller has checked active workspace membership. Only public-facing project metadata and active case tags are projected.
export async function searchPosterSources(ws:string, projectId:string, search:SolReferenceSearch, now=new Date()):Promise<PosterSources> {
  let cards:SolReferenceCard[];
  if(search.kind==="campaign"){
    const term=search.query.trim();
    const year=search.year;
    const start=year ? new Date(Date.UTC(year,0,1)) : undefined;
    const end=year ? new Date(Math.min(+now, Date.UTC(year+1,0,1))) : now;
    const matches=await prisma.project.findMany({where:{workspaceId:ws,id:{not:projectId},archivedAt:null,
      AND:[{OR:[{name:{contains:term,mode:"insensitive"}},{campaign:{contains:term,mode:"insensitive"}},{tags:{has:term}}]},
        {OR:[{startDate:null},{startDate:{lt:end},...(start && {OR:[{endDate:{gte:start}},{endDate:null,startDate:{gte:start}}]})}]}]},
      select:projectFields(ws),orderBy:[{startDate:{sort:"desc",nulls:"last"}},{id:"asc"}],take:6});
    cards=matches.map(p=>campaignCard(ws,p));
  } else {
    const {cases}=await currentCases(ws,undefined,undefined,{query:search.query});
    cards=cases.filter(c=>c.analysisAllowed).map(c=>({c,score:keywordScore(c,search.query)}))
      .filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.c.caseId.localeCompare(b.c.caseId)).slice(0,6).map(x=>inspirationCard(ws,x.c));
  }
  const candidates=cards.map(asSourceKey);
  const one=cards.length===1 && !(search.year && !cards[0]!.date);
  return {search,candidates,selected:one?candidates[0]!:null,currentOnly:false};
}
export async function liveSourceCards(db:Db, ws:string, projectId:string, keys:PosterSources["candidates"]){
  if(!keys.length)return [];
  const ids=keys.filter(k=>k.kind==="campaign"&&k.id!==projectId).map(k=>k.id);
  const cards:SolReferenceCard[]=ids.length ? (await db.project.findMany({where:{workspaceId:ws,id:{in:ids},archivedAt:null},
    select:projectFields(ws)})).map(p=>campaignCard(ws,p)) : [];
  const cases=keys.filter(k=>k.kind==="inspiration");
  for(const library of new Set(cases.map(k=>k.libraryId))){
    try {
      const current=await currentCases(ws,library,cases.filter(k=>k.libraryId===library).map(k=>k.id));
      cards.push(...current.cases.filter(c=>c.analysisAllowed).map(c=>inspirationCard(ws,c)));
    } catch(e){if(!(e instanceof ApiException) || ![403,404,409].includes(e.status))throw e;}
  }
  return keys.flatMap(k=>cards.filter(c=>sameSource(k,c)));
}
export async function sourceView(db:Db,ws:string,projectId:string,s:PosterSources) {
  const cards=s.currentOnly ? [] : await liveSourceCards(db,ws,projectId,s.candidates);
  const selected=cards.find(c=>s.selected&&sameSource(c,s.selected))??null;
  return {search:s.search,candidates:cards,selected,stale:!!s.selected&&!selected&&!s.currentOnly,currentOnly:s.currentOnly};
}
export async function requireSelectedSource(db:Db,ws:string,p:string,s:PosterSources|undefined) {
  if(!s||s.currentOnly)return null;
  const key=s.selected;
  if(!key)throw new ApiException(409,"请选择参考，或选择仅用当前项目资料。");
  const [card]=await liveSourceCards(db,ws,p,[key]);
  if(!card)throw new ApiException(409,"引用来源已更新或撤回，请重新选择参考。");
  return card;
}

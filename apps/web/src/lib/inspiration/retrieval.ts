import { Prisma, prisma } from '@brandai/db';
import { currentAnalysisCases, requireActiveEditor } from './access';
import { keywordScore, listCases } from './service';
import { embeddingConfig, embedTexts, rankHybrid, type CachedEmbedding } from './semantic';

export async function retrieveInspirationCases(workspaceId:string,userId:string,question:string,signal:AbortSignal) {
  await requireActiveEditor(workspaceId,userId);
  let candidates=(await listCases(workspaceId)).cases.filter(c=>c.analysisAllowed).map(c=>({...c,allowed:true,keywordScore:keywordScore(c,question),embedding:undefined as CachedEmbedding|undefined}));
  const config=embeddingConfig();let query:CachedEmbedding|null=null;
  if(config && candidates.length) {
    const cache={scope:workspaceId,cache:{get:async(key:string)=>(await prisma.inspirationEmbedding.findUnique({where:{workspaceId_key:{workspaceId,key}}}))?.payloadJson,
      put:async(key:string,payload:CachedEmbedding)=>{await prisma.inspirationEmbedding.upsert({where:{workspaceId_key:{workspaceId,key}},create:{workspaceId,key,payloadJson:payload as unknown as Prisma.InputJsonValue},update:{payloadJson:payload as unknown as Prisma.InputJsonValue}});}}};
    // Even a cache hit must not let a disabled account proceed into query embedding.
    await requireActiveEditor(workspaceId,userId);signal.throwIfAborted();
    const q=await embedTexts(config,[question],signal,cache);if(q.ok)query={space:q.space,dimensions:config.dimensions,vector:q.vectors[0]!};
    const pending=[...candidates];
    if(query)for(let i=0;i<pending.length;i+=16) {
      // Apply current ACL to the entire retained candidate set, then to this batch.
      // Invalid candidates never reach cache reads, external embedding or ranking.
      candidates=await currentAnalysisCases(workspaceId,userId,candidates);signal.throwIfAborted();
      const currentIds=new Set(candidates.map(c=>`${c.caseId}:${c.revision}`));
      const batch=pending.slice(i,i+16).filter(c=>currentIds.has(`${c.caseId}:${c.revision}`));if(!batch.length)continue;
      const r=await embedTexts(config,batch.map(c=>[c.title,c.summary,...Object.values(c.tags).flat()].join('\n').slice(0,3500)),signal,cache);if(!r.ok)break;
      batch.forEach((c,j)=>{c.embedding={space:r.space,dimensions:config.dimensions,vector:r.vectors[j]!};});
    }
  }
  candidates=await currentAnalysisCases(workspaceId,userId,candidates);signal.throwIfAborted();
  const ranked=rankHybrid(candidates,query,6);
  return ranked.cases.filter(c=>ranked.searchMode==='hybrid'||c.keywordScore>0);
}

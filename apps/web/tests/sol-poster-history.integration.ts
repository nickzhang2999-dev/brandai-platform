/** Run with tsx against the dedicated loopback fixture DB. Refuses any other destination. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@brandai/db";
import { searchPosterSources,sourceView,requireSelectedSource } from "../src/lib/sol-poster-references";
import { posterCopyPolicy } from "../src/lib/sol-poster-copy";
async function run() {
  const url=new URL(process.env.DATABASE_URL??"");
  assert.equal(url.host,"127.0.0.1:26488");assert.equal(url.pathname,"/brief");
  const suffix=randomUUID().slice(0,8);
  const owner=await prisma.user.create({data:{email:suffix+"@example.invalid"}});
  const brands=await Promise.all(["服饰","家电"].map(name=>prisma.brandWorkspace.create({data:{ownerId:owner.id,name}})));
  const now=new Date("2026-11-27");
  const search=(ws:string,id:string,query:string,year:number|null=2025)=>searchPosterSources(ws,id,{kind:"campaign",query,year},now);
  let checks=0;
  for(const ws of brands){
    const dated=async(name:string,date:string|null,tags:string[]=[])=>prisma.project.create({data:{name,workspaceId:ws.id,startDate:date?new Date(date):null,tags}});
    const current=await dated("夏季新品","2026-07-01");
    const first=await dated("夏季橱窗","2025-06-01",["留白"]);
    await dated("夏季旧版","2024-07-01");
    const exact=await search(ws.id,current.id,"夏季");
    assert.equal(exact.selected?.id,first.id);
    const view=await sourceView(prisma,ws.id,current.id,exact);
    assert.equal(view.selected?.style[0],"留白");assert.ok(view.selected?.url.includes(first.id));checks++;
    const second=await dated("夏季市集","2025-07-01");
    const ambiguous=await search(ws.id,current.id,"夏季");assert.equal(ambiguous.selected,null);
    assert.deepEqual(new Set(ambiguous.candidates.map(k=>k.id)),new Set([first.id,second.id]));checks++;
    const unknown=await dated("夏季手稿",null);
    const undated=await search(ws.id,current.id,"手稿");assert.equal(undated.candidates[0]?.id,unknown.id);assert.equal(undated.selected,null);
    assert.equal((await search(ws.id,current.id,"从未使用的主题")).candidates.length,0);checks++;
    const other=brands.find(b=>b.id!==ws.id)!;
    assert.equal((await sourceView(prisma,other.id,current.id,exact)).selected,null);
    assert.equal((await sourceView(prisma,ws.id,first.id,exact)).selected,null);checks++;
    await prisma.project.update({where:{id:first.id},data:{tags:["新版本"]}});
    assert.equal((await sourceView(prisma,ws.id,current.id,exact)).stale,true);
    await assert.rejects(requireSelectedSource(prisma,ws.id,current.id,exact));
    const updated=await search(ws.id,current.id,"橱窗");
    await prisma.project.update({where:{id:first.id},data:{archivedAt:new Date()}});
    assert.equal((await sourceView(prisma,ws.id,current.id,updated)).candidates.length,0);checks++;
    const copy=posterCopyPolicy("保留商品原色，不要使用旧口号「旧夏」","旧夏\n夏日轻风");
    assert.deepEqual(copy.excluded,["旧夏"]);assert.equal(copy.copy,"夏日轻风");assert.ok(!copy.designNotes.includes("旧夏"));checks++;
  }
  console.log(JSON.stringify({brands:brands.length,checks}));
}
run().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>prisma.$disconnect());

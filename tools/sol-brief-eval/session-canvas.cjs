/** Uses the isolated local integration DB with the two synthetic fixture projects already seeded. */
const assert = require("node:assert/strict");
const path = require("node:path");
const {createRequire} = require("node:module");
const root = path.resolve(__dirname, "../..");
const from = createRequire(path.join(root, "package.json"));
const {chromium} = from("playwright-core");
const sharp = createRequire(path.join(root,"apps/web/package.json"))("sharp");
const base="http://127.0.0.1:26490", uid="brieftester";
const headers={origin:base,"X-Novart-User":uid};
const runId=crypto.randomUUID().slice(0,8);
const products=["AT-01","ST-02"].map(s=>{
  const fixture=require("./fixtures/"+s+".json");
  return {...fixture,project:fixture.project+"-"+runId};
});
const api=(f,action)=>base+"/api/workspaces/"+f.workspace+"/projects/"+f.project+"/"+action;
const url=f=>base+"/studio-editor?surface=canvas&workspaceId="+f.workspace+"&projectId="+f.project;
const results=[];
let stage = "initialize browser fixtures";
const joint = process.env.SOL_TEST_APPEARANCE === "1";
const readFixtureCalls = () => {
  const fs=require("node:fs"), file=process.env.SOL_TEST_IMAGE_CALLS;
  assert.ok(file,"Provide the dedicated appearance fixture journal");
  return fs.existsSync(file) ? fs.readFileSync(file,"utf8").trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)) : [];
};
const approval = row => ({ action: "confirm-appearance", briefId: row.id, target: row.target,
  documentRevision: row.documentRevision, contextRevision: row.contextRevision });
async function verify(){
  const dbUrl=process.env.SOL_TEST_DATABASE_URL;
  if(!dbUrl) throw new Error("Set the isolated test database URL");
  const urlDb=new URL(dbUrl);
  if(urlDb.protocol!=="postgresql:" || urlDb.host!=="127.0.0.1:26488" || urlDb.pathname!=="/brief" || urlDb.search)
    throw new Error("This browser fixture requires the dedicated loopback database");
  const {PrismaClient}=createRequire(path.join(root,"packages/db/package.json"))("@prisma/client");
  const db=new PrismaClient({datasourceUrl:dbUrl});
  // The dedicated fixture account signs in through the same password route as Studio users.
  const {randomBytes,scryptSync}=require("node:crypto");
  const password=randomBytes(32).toString("hex"), salt=randomBytes(16);
  try {
    for(const f of products){
      const ws=await db.brandWorkspace.findUniqueOrThrow({where:{id:f.workspace}});
      assert.equal(ws.ownerId,uid);assert.equal(ws.name,f.brand);
      await db.project.create({data:{id:f.project,name:f.product,workspaceId:f.workspace}});
    }
    await db.user.update({where:{id:uid,email:uid+"@example.invalid"},
      data:{passwordHash:["scrypt",salt.toString("hex"),scryptSync(password,salt,64).toString("hex")].join("$")}});
  } finally {await db.$disconnect();}
  const browser=await chromium.launch({executablePath:process.env.TEST_CHROME,headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1600,height:1050}});
    const http=context.request;
    const page=await context.newPage();
    page.setDefaultTimeout(75000);
    const {csrfToken}=await (await http.get(base+"/api/auth/csrf")).json();
    await http.post(base+"/api/auth/callback/password",{form:{csrfToken,email:uid+"@example.invalid",password,callbackUrl:base},maxRedirects:0});
    assert.equal((await (await http.get(base+"/api/auth/session")).json()).user.id,uid);
    async function open(f,seed=false,selectProduct=true){
      await page.goto(url(f));
      const editor=page.getByTestId("owned-editor");
      await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]')?.dataset.saveState==="saved");
      const history=await (await http.get(api(f,"sol-poster-brief"),{headers})).json();
      const known=history.find(r=>r.product===f.product+".png" && r.status==="SUCCEEDED");
      const img=known ? editor.locator('[data-owned-id="'+known.target.shapeId+'"]') :
        editor.locator('[data-testid="owned-canvas-item"][data-kind="image"]').first();
      if(seed && !await img.count()){
        const buffer=await sharp(path.join(__dirname,"fixtures",f.sku+".svg")).png().toBuffer();
        await page.getByLabel("选择图片",{exact:true}).setInputFiles({name:f.product+".png",mimeType:"image/png",buffer});
      }
      if(selectProduct){await img.waitFor();await img.click();}
      await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]')?.dataset.saveState==="saved");
      const title=page.getByText("Sol 海报简报",{exact:true}),panel=title.locator("..");
      await title.click();
      await panel.getByLabel("设计需求").waitFor();
      return panel;
    }
    async function seed(f,audience){
      await open(f,true);
      const materials=await http.get(base+"/studio/materials?workspaceId="+f.workspace+"&projectId="+f.project,{headers});
      const m=(await materials.json()).find(m=>m.fileName===f.product+".png");assert.ok(m);
      const endpoint=api(f,"studio-project-context");
      const read=await http.get(endpoint,{headers});assert.equal(read.status(),200);
      const write=await http.put(endpoint,{headers,data:{mutationId:crypto.randomUUID(),expectedRevision:(await read.json()).revision,
        materials:[{assetId:m.assetId,assetSha256:m.assetSha256,role:"PRODUCT"}],master:null,
        facts:{goal:"商品推广",audience,visualRequirements:f.keep.join("、"),approvedCopy:f.copy}}});
      assert.equal(write.status(),200);
    }
    async function turn(panel,f,message,answer){
      stage = "submit brief for " + f.sku + " / turn " + (results.length + 1);
      await panel.getByLabel("设计需求").fill(message);
      if(answer) await panel.getByLabel("这张海报主要给谁看？").fill(answer);
      const [res] = await Promise.all([
        page.waitForResponse(r=>r.url()===api(f,"sol-poster-brief") && r.request().method()==="POST"),
        panel.getByRole("button",{name:"生成海报简报"}).click(),
      ]);
      assert.equal(res.status(),202,"Brief submission HTTP " + res.status());
      const receipt=await res.json();
      const article=panel.locator('article[data-brief-id="'+receipt.id+'"]');
      await article.getByText("商品已确认文案 · "+f.copy,{exact:true}).waitFor();
      await article.getByText("品牌规范 · "+[f.color,f.typeface,f.mark].join(" · "),{exact:true}).waitFor();
      const rows=await (await http.get(api(f,"sol-poster-brief"),{headers})).json();
      const row=rows.find(x=>x.id===receipt.id);assert.equal(row.status,"SUCCEEDED");
      results.push({id:row.id,sku:f.sku,choices:row.result.choices,resumed:row.conversation.resumed,
        reusedDirection:row.conversation.reusedDirection,question:row.conversation.question,audience:row.conversation.audience});
      return {row,input:res.request().postDataJSON()};
    }
    const [shirt,fan]=products;
    await seed(shirt,""); await seed(fan,"桌面办公人群");
    let panel=await open(shirt);
    const first=await turn(panel,shirt,"规划三张夏季推广海报。");
    assert.ok(first.row.conversation.question);
    if (joint) assert.equal((await http.post(api(shirt,"sol-poster-brief"),{headers,data:approval(first.row)})).status(),409);
    panel=await open(shirt);
    const audienceBrief=await turn(panel,shirt,"背景保留纸张纹理。外观选正面主视，场景选纯色摄影背景，细节选引线标注。","大学生");
    assert.equal(audienceBrief.row.conversation.resumed,true);
    assert.equal(audienceBrief.row.conversation.audience,"大学生");
    const revisedBrief=await turn(panel,shirt,"外观改为轮廓留白，场景继续选纯色摄影背景，细节继续选引线标注。");
    assert.ok(revisedBrief.row.conversation.designNotes.includes("背景保留纸张纹理"),"Missing second-turn design requirement in approval");
    assert.deepEqual(revisedBrief.row.result.choices,{appearance:"轮廓留白",scene:"纯色摄影背景",detail:"引线标注"});
    assert.equal(revisedBrief.row.conversation.resumed,true);assert.equal(revisedBrief.row.conversation.question,null);
    await panel.locator("article").first().getByRole("button",{name:"记住这组构图"}).click();
    if (joint) {
      stage = "confirm revised brief once";
      const initialCallCount=readFixtureCalls().length;
      const endpoint = api(shirt,"sol-poster-brief");
      assert.equal((await http.post(endpoint,{headers,data:approval(audienceBrief.row)})).status(),409);
      assert.equal((await http.post(api(fan,"sol-poster-brief"),{headers,data:approval(revisedBrief.row)})).status(),404);
      const confirm = panel.getByRole("button",{name:/确认简报，生成一张外观图/});
      const [ui, duplicates] = await Promise.all([
        page.waitForResponse(r=>r.url()===endpoint && r.request().method()==="POST"),
        page.waitForRequest(r=>r.url()===endpoint && r.method()==="POST").then(request=>
          Promise.all(Array.from({length:2},()=>http.post(endpoint,{headers,data:request.postDataJSON()})))),
        confirm.click(),
      ]);
      const input = ui.request().postDataJSON();
      for (const r of [ui, ...duplicates]) assert.equal(r.status(),202,"Confirm appearance HTTP " + r.status());
      const task = await ui.json();
      for (const r of duplicates) assert.equal((await r.json()).requestId,task.requestId);
      assert.equal(task.projectId,shirt.project);
      const generation = base + "/studio/generation?" + new URLSearchParams({
        workspaceId:shirt.workspace, projectId:shirt.project, requestId:task.requestId});
      let result;
      stage = "await saved appearance result";
      for (let i=0;i<90;i++) {
        const r = await http.get(generation,{headers}); assert.equal(r.status(),200,"Read appearance HTTP " + r.status());
        result = await r.json();
        assert.notEqual(result.status,"FAILED","Appearance generation failed");
        assert.notEqual(result.resultState,"FAILED","Archiving the appearance failed");
        if (result.resultState==="READY") break;
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      assert.equal(result.resultState,"READY"); assert.equal(result.results.length,1);
      const output = result.results[0];
      assert.deepEqual([output.width,output.height],[1024,1024],"Archived poster size");
      const hash = require("node:crypto").createHash("sha256").update(await (await http.get(base+output.url,{headers})).body()).digest("hex");
      assert.equal(hash,output.assetSha256); assert.notEqual(hash,revisedBrief.row.target.assetSha256);
      const shown = async ()=>{
        const placed = page.locator('[data-testid="owned-canvas-item"] svg image[href="'+output.url+'"]');
        await placed.waitFor({state:"visible"}); assert.equal(await placed.count(),1);
        const snapshot = await placed.evaluate(async el=>{
          const img=new Image(); img.src=el.getAttribute("href"); await img.decode();
          const shape=el.closest('[data-testid="owned-canvas-item"]');
          return {id:shape.dataset.ownedId, x:shape.style.left, y:shape.style.top, width:shape.style.width,
            height:shape.style.height, pixels:[img.naturalWidth,img.naturalHeight], error:!!el.closest("[data-image-error]")};
        });
        assert.ok(snapshot.id && snapshot.x && snapshot.y && snapshot.width && snapshot.height,"Missing placed shape geometry");
        assert.deepEqual(snapshot.pixels,[1024,1024],"Decoded poster size");
        assert.equal(snapshot.error,false,"Canvas reports an image error");
        return snapshot;
      };
      stage = "verify placed poster identity and geometry";
      const savedShape = await shown();
      await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]')?.dataset.saveState==="saved");
      stage = "reopen canvas and check saved shape";
      panel=await open(shirt,false,false);
      assert.deepEqual(await shown(),savedShape,"Reopening changed the saved poster object or geometry");
      stage = "open exact task from its brief";
      const linkedBrief = panel.locator('article[data-brief-id="'+revisedBrief.row.id+'"]');
      const [lookup] = await Promise.all([
        page.waitForResponse(r=>{
          const location=new URL(r.url());
          return location.pathname==="/studio/generation" && location.searchParams.get("requestId")===task.requestId;
        }),
        linkedBrief.getByRole("button",{name:"已提交外观图 · 查看任务记录"}).click(),
      ]);
      assert.equal(lookup.status(),200,"Linked task lookup HTTP " + lookup.status());
      const history = page.getByRole("region",{name:"项目任务记录"});
      const card = history.locator('[data-task-id="'+task.requestId+'"]');
      const original = card.getByAltText("生成结果",{exact:true});
      await original.waitFor({state:"visible"});
      assert.equal(await history.locator("[data-task-id]").count(),1,"Brief opened the unfiltered project history");
      assert.equal(await original.getAttribute("src"),output.url,"Task card linked to a different image");
      assert.deepEqual(await original.evaluate(async img=>{await img.decode();return [img.naturalWidth,img.naturalHeight];}),
        [1024,1024],"Original image cannot be read from the linked card");
      const replay=await http.post(endpoint,{headers,data:input});assert.equal(replay.status(),202);
      assert.equal((await replay.json()).requestId,task.requestId);
      const native=await db.studioGenerationRequest.findMany({where:{projectId:shirt.project}});
      assert.deepEqual(native.map(r=>r.id),[task.requestId]);
      assert.ok(native[0].providerStartedAt);
      const src = Object.values(native[0].jobData.studioExpectedAssetSha256);
      assert.deepEqual(src,[revisedBrief.row.target.assetSha256]);
      const received=readFixtureCalls().slice(initialCallCount);
      assert.deepEqual(received,[{referenceHashes:src,layout:true,audience:true,earlierRequirements:true}],"Provider received incorrect reference, layout, audience or design history");
      console.log(JSON.stringify({jointAppearance:{project:shirt.project,brief:revisedBrief.row.id,request:task.requestId,
        asset:output.assetId,reference:src[0],sha256:hash,dimensions:[output.width,output.height],
        nativeRequests:native.length,providerPosts:received.length,duplicateConfirmations:duplicates.length,
        savedShape,visibleAfterReopen:true,linkedTaskOpened:true}}));
    }
    panel=await open(fan);
    const fanBrief=await turn(panel,fan,"按刚才的方案继续。");
    assert.equal(fanBrief.row.conversation.resumed,false);assert.equal(fanBrief.row.conversation.reusedDirection,true);
    assert.deepEqual(fanBrief.row.result.choices,revisedBrief.row.result.choices);
    assert.equal(fanBrief.row.conversation.audience,"桌面办公人群");
    panel=await open(fan);
    await panel.getByText("商品已确认文案 · "+fan.copy,{exact:true}).first().waitFor();
    const visible=await panel.innerText();assert.ok(!visible.includes(shirt.copy) && !visible.includes(shirt.brand));
    const replay=await http.post(api(fan,"sol-poster-brief"),{headers,data:fanBrief.input});
    assert.equal(replay.status(),202);assert.equal((await replay.json()).id,fanBrief.row.id);
    const wrong=await http.post(api(fan,"sol-poster-brief"),{headers,data:{...fanBrief.input,mutationId:crypto.randomUUID(),
      conversation:{message:"继续",parentId:first.row.id}}});
    assert.equal(wrong.status(),409);
    // Keep the shirt as the project's confirmed product, then select a different image in the same document.
    panel=await open(shirt,false,false);
    const images=page.locator('[data-testid="owned-canvas-item"][data-kind="image"]');
    const before=new Set(await images.evaluateAll(xs=>xs.map(x=>x.dataset.ownedId)));
    const other=await sharp(path.join(__dirname,"fixtures",fan.sku+".svg")).png().toBuffer();
    await page.getByLabel("选择图片",{exact:true}).setInputFiles({name:fan.product+".png",mimeType:"image/png",buffer:other});
    await page.waitForFunction(ids=>[...document.querySelectorAll('[data-testid="owned-canvas-item"][data-kind="image"]')].some(x=>!ids.includes(x.dataset.ownedId)),[...before]);
    const ids=await images.evaluateAll(xs=>xs.map(x=>x.dataset.ownedId));
    const newId=ids.find(id=>!before.has(id));assert.ok(newId);
    const newImage=page.locator('[data-owned-id="'+newId+'"]');
    if(await newImage.getAttribute("data-selected")!=="true") await newImage.click();
    await page.waitForFunction(id=>document.querySelector('[data-owned-id="'+id+'"]')?.dataset.selected==="true",newId);
    await panel.getByLabel("设计需求").fill("为新选中的商品沿用这组构图");
    stage = "submit brief after changing product";
    const [change]=await Promise.all([
      page.waitForResponse(r=>r.url()===api(shirt,"sol-poster-brief") && r.request().method()==="POST"),
      panel.getByRole("button",{name:"生成海报简报"}).click(),
    ]);
    assert.equal(change.status(),202,"Changed product brief HTTP " + change.status());
    const changed=await change.json();
    assert.equal(changed.target.shapeId,newId);
    const newest=panel.locator('article[data-brief-id="'+changed.id+'"]');
    await newest.getByText(/商品卖点待确认/).waitFor();
    assert.ok(changed.product.includes(fan.product) && changed.brand===shirt.brand);
    assert.ok(!(await newest.innerText()).includes(shirt.copy));
    assert.equal(changed.conversation.resumed,false);
    console.log(JSON.stringify({passed:true,turns:results,refresh:true,replay:true,wrongParentStatus:wrong.status(),
      switchOnSameCanvas:{id:changed.id,currentProduct:changed.product,resumed:changed.conversation.resumed,oldCopyVisible:false}}));
  } finally {await browser.close();await db.$disconnect();}
}
verify().catch(error=>{
  const firstLine = String(error.message ?? error).split(/[\r\n]/,1)[0];
  const summary = firstLine.replace(/\b(?:set-cookie|cookie|authorization)\s*[:=].*/i,"[redacted]");
  const source = String(error.stack ?? "").match(/session-canvas\.cjs:\d+:\d+/)?.[0];
  console.error(stage + (source ? " (" + source + ")" : "") + " — " + summary);
  process.exitCode=1;
});

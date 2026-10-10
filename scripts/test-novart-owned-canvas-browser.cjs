/* Actual React editor interactions against an isolated loopback fixture API.
 * No provider, account, database, user browser or third-party editor is used.
 * This is an interaction regression, not production/backend acceptance. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');
const repo = path.resolve(__dirname, '..');
const temporaryRoot = path.join(repo, '.novart-build', 'temporary');
fs.mkdirSync(temporaryRoot, {recursive: true});
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'owned-browser-'));
assert.equal(path.dirname(directory), temporaryRoot);
const esbuildPackage = fs.readdirSync(path.join(repo, 'node_modules/.pnpm')).find(n => n.startsWith('esbuild@0.28.'));
assert.ok(esbuildPackage, 'Use the already installed build dependency');
const esbuild = require(path.join(repo, 'node_modules/.pnpm', esbuildPackage, 'node_modules/esbuild'));
const fixture = {workspaceId:'fixture-workspace', projectId:'fixture-project', userId:'fixture-user'};
const report = {isolated:true, realBackend:false, realProvider:false, checks:[], externalRequests:[], errors:[]};
let stage = 'build-fixture', browser, server, contracts;
let canvas = '', revision = 0, readOnly = false, writes = 0, failRestore = false, conflict = false, delayMaterials = 0;
let draft = {projectId:fixture.projectId,revision:0,inputForm:null,updatedAt:null,referenceIssues:[]};
let workflow = {projectId:fixture.projectId,revision:0,mode:'generate',target:null,references:[],updatedAt:null,issues:[]};
let draftWrites = 0, workflowWrites = 0, generationPosts = 0;
const uploads = new Map(), generations = new Map(), taskReads = [], generationPostInputs = [];
function pngChunk(type, value) {
  const payload=Buffer.concat([Buffer.from(type),value]), result=Buffer.alloc(value.length+12);let crc=0xffffffff;
  for(const byte of payload) {crc^=byte;for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  result.writeUInt32BE(value.length);payload.copy(result,4);result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result;
}
const imageHeader=Buffer.alloc(13);imageHeader.writeUInt32BE(1,0);imageHeader.writeUInt32BE(1,4);imageHeader[8]=8;imageHeader[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',imageHeader),pngChunk('IDAT',zlib.deflateSync(Buffer.from([0,124,92,255,255]))),pngChunk('IEND',Buffer.alloc(0))]);
const assetSha256 = crypto.createHash('sha256').update(png).digest('hex');
const material = {id:'fixture-asset',assetId:'fixture-asset',assetSha256,fileName:'fixture.png',mimeType:'image/png',sizeBytes:png.length,width:1,height:1,url:'/api/workspaces/fixture-workspace/assets/fixture-asset/raw',kind:'image'};
function json(res, value, status=200) {res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function documentView() {return {workspaceId:fixture.workspaceId,projectId:fixture.projectId,format:'novart-native-v1',canvas,revision,checksum:canvas?crypto.createHash('sha256').update(canvas).digest('hex'):null,updatedAt:revision?new Date().toISOString():null,readOnly};}
function records() {return canvas ? JSON.parse(zlib.gunzipSync(Buffer.from(canvas.slice('SHAKKERDATA://'.length),'base64'))).tldrawSnapshot.document.store : {};}
function shapes() {return Object.values(records()).filter(r=>r.typeName==='shape');}
function currentWorkflowAssets() {return contracts.workflowAssets(fixture.projectId,canvas,uploads.size?[{sha256:assetSha256,url:material.url,mimeType:material.mimeType}]:[]);}
function workflowView() {const assets=currentWorkflowAssets();return contracts.StudioWorkflowView.parse({...workflow,issues:[...assets.issues,...contracts.workflowIssues(workflow,assets.assets)]});}
async function body(req) {const chunks=[];for await(const c of req) chunks.push(c);return Buffer.concat(chunks);}
async function handle(req,res) {
  const url = new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/app.js'||url.pathname==='/app.css') {res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript':'text/css');return res.end(url.pathname.endsWith('.css')?Buffer.concat([fs.readFileSync(path.join(directory,'tokens.css')),fs.readFileSync(path.join(directory,'app.css'))]):fs.readFileSync(path.join(directory,'app.js')));}
  if(url.pathname.startsWith('/fonts/')) {const file=path.resolve(repo,'apps/web/public',url.pathname.slice(1));if(file.startsWith(path.join(repo,'apps/web/public/fonts')+path.sep)&&fs.existsSync(file))return res.end(fs.readFileSync(file));res.writeHead(404);return res.end();}
  if(url.pathname==='/shell'||url.pathname==='/studio') {res.setHeader('Content-Type','text/html');return res.end(`<html><head><meta charset="utf-8"></head><body style="margin:0"><div class="ns-sidebar-bottom" style="position:fixed;bottom:20px;left:12px;z-index:1000;background:white"></div><div class="ns-frame-slot" data-active="true"><iframe data-testid="studio-canvas-frame" data-project-id="${fixture.projectId}" data-ready="false" style="width:100vw;height:100vh;border:0" src="/studio-editor"></iframe></div><script>window.__NOVART_PRODUCT__={workspaceId:${JSON.stringify(fixture.workspaceId)},user:{id:${JSON.stringify(fixture.userId)}}};window.receipts=[];addEventListener('message',e=>{const frame=document.querySelector('iframe');if(e.origin===location.origin&&e.source===frame.contentWindow){receipts.push(e.data);if(e.data?.type==='nv-studio'&&e.data.action==='ready')frame.dataset.ready='true';}});</script><script src="/product-task-inbox.js"></script><script>NovartProductTaskInbox.start();</script></body></html>`);}
  if(url.pathname==='/product-task-inbox.js') {res.setHeader('Content-Type','application/javascript');return res.end(fs.readFileSync(path.join(repo,'deploy/novart/studio/novart-product-task-inbox.js')));}
  if(url.pathname==='/owned-home-start.js') {res.setHeader('Content-Type','application/javascript');return res.end(fs.readFileSync(path.join(repo,'deploy/novart/studio/novart-owned-home-start.js')));}
  if(url.pathname==='/home-fixture') {
    res.setHeader('Content-Type','text/html');return res.end(`<html><head><meta charset="utf-8"></head><body>
      <div id="ns-composer"><textarea id="ns-home-brief"></textarea><button id="hs-pick">添加图片</button><input id="hs-file-input" type="file" multiple><button id="ns-create"><span>创建项目</span></button><button id="ns-create-blank">空白</button></div>
      <div id="hs-attachments"></div><div id="hs-draft-note"></div><div id="hs-recovery"></div><div id="ns-create-status"></div><div id="hs-handoff" hidden></div><div id="ns-frames"></div>
      <script>window.__NOVART_PRODUCT__=${JSON.stringify(fixture)};</script><script src="/owned-home-start.js"></script><script>
      const entry={id:${JSON.stringify(fixture.projectId)},ready:false,frame:document.createElement('iframe')};entry.frame.style='width:100%;height:750px';document.getElementById('ns-frames').append(entry.frame);let created=false;
      const node=(tag,cls,text)=>{const el=document.createElement(tag);el.className=cls||'';if(text!==undefined)el.textContent=text;return el;};
      const button=(text,cls,fn)=>{const el=node('button',cls,text);el.addEventListener('click',fn);return el;};
      window.homeStart=createHomeStart({node,button,api:async(route,value)=>{const r=await fetch(route,value?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}:{});const data=await r.json();if(!r.ok)throw Error(data.error);return data;},notify:()=>{},reloadProjects:async()=>{created=true;},project:id=>created&&id===entry.id?{projectId:id}:null,current:e=>e===entry&&entry.ready,legacyBlocked:()=>false,composing:()=>false,
        openProject:()=>{entry.frame.src='/studio-editor';},frameDocument:e=>({win:e.frame.contentWindow,doc:e.frame.contentDocument}),goProjects:()=>{},invalidateAssets:()=>{},showRequirements:()=>{},refreshImportedFrame:e=>{e.ready=false;e.frame.src='/studio-editor';}});
      document.getElementById('ns-create').addEventListener('click',()=>homeStart.create());addEventListener('message',e=>{if(e.origin===location.origin&&e.source===entry.frame.contentWindow&&e.data?.action==='ready'){entry.ready=true;homeStart.resume(entry);}});
      </script></body></html>`);
  }
  if(url.pathname==='/studio-editor'||url.pathname==='/canvas') {res.setHeader('Content-Type','text/html');return res.end('<html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}
  if(url.pathname==='/compare/api/create'&&req.method==='POST') {const value=JSON.parse((await body(req)).toString());assert.ok(value.requestId);return json(res,{projectId:fixture.projectId,projectName:value.projectName});}
  if(url.pathname.includes('/editor-document')) {
    if(req.method==='GET') return failRestore ? json(res,{error:'合成恢复失败'},503) : json(res,documentView());
    const value=JSON.parse((await body(req)).toString());
    if(readOnly) return json(res,{error:'只读项目'},403);
    if(conflict || value.revision!==revision) return json(res,{error:'画布已在其他页面更新',code:'DOCUMENT_CONFLICT'},409);
    canvas=value.canvas;revision++;writes++;return json(res,documentView());
  }
  if(['/studio/draft','/workflow','/workflow/assets','/studio/generation'].includes(url.pathname)
    && (url.searchParams.get('workspaceId')!==fixture.workspaceId||url.searchParams.get('projectId')!==fixture.projectId||req.headers['x-novart-user']!==fixture.userId)) return json(res,{error:'Fixture identity scope mismatch'},403);
  if(url.pathname==='/studio/draft') {
    if(req.method==='GET') return json(res,contracts.WorkbenchDraftView.parse(draft));
    const value=contracts.WorkbenchDraftSaveInput.safeParse(JSON.parse((await body(req)).toString()));
    if(!value.success||value.data.projectId!==fixture.projectId) return json(res,{error:'Fixture draft input rejected'},422);
    if(readOnly) return json(res,{error:'只读项目'},403);
    if(value.data.revision!==draft.revision) return json(res,{error:'草稿已在其他页面更新'},409);
    draft=contracts.WorkbenchDraftView.parse({...value.data,revision:draft.revision+1,updatedAt:Date.now(),referenceIssues:[]});draftWrites++;return json(res,draft);
  }
  if(url.pathname==='/workflow/assets') return json(res,currentWorkflowAssets());
  if(url.pathname==='/workflow') {
    if(req.method==='GET') return json(res,workflowView());
    const value=contracts.StudioWorkflowSaveInput.safeParse(JSON.parse((await body(req)).toString()));
    if(!value.success||value.data.projectId!==fixture.projectId) return json(res,{error:'Fixture workflow input rejected'},422);
    if(readOnly) return json(res,{error:'只读项目'},403);
    if(value.data.revision!==workflow.revision) return json(res,{error:'素材设置已在其他页面更新'},409);
    // Reuse the real document/material codec and selection guard. A choice
    // cannot become valid solely because the synthetic UI submitted an ID.
    if(!contracts.assertWorkflowSelection(value.data,workflow,currentWorkflowAssets().assets)) return json(res,{error:'素材不属于已保存画布'},422);
    workflow={...value.data,revision:workflow.revision+1,updatedAt:Date.now(),issues:[]};workflowWrites++;return json(res,workflowView());
  }
  if(url.pathname==='/studio/materials') {if(delayMaterials) await new Promise(resolve=>setTimeout(resolve,delayMaterials));return json(res,uploads.size?[material]:[]);}
  if(url.pathname==='/studio/material-upload') {
    if(req.method==='POST') {
      const raw=(await body(req)).toString('latin1');
      const mutationId=raw.match(/name="mutationId"\r\n\r\n([^\r]+)/)?.[1]; assert.ok(mutationId);
      const task={taskId:'fixture-upload',projectId:fixture.projectId,mutationId,status:'SUCCEEDED',progress:100,expiresAt:new Date(Date.now()+60000).toISOString(),material};
      uploads.set(task.taskId,task);return json(res,task,202);
    }
    if(url.searchParams.has('taskId')) {const id=url.searchParams.get('taskId');taskReads.push({kind:'STUDIO_UPLOAD',id});return uploads.has(id)?json(res,uploads.get(id)):json(res,{error:'任务不存在'},404);}
    return json(res,{tasks:[...uploads.values()]});
  }
  if(url.pathname==='/studio/generation') {
    if(req.method==='POST') {
      generationPosts++;const input=JSON.parse((await body(req)).toString());generationPostInputs.push(input);const value=contracts.StudioGenerationInput.safeParse(input);
      if(!value.success||value.data.projectId!==fixture.projectId) return json(res,{error:'Fixture generation input rejected'},422);
      if(value.data.workflowRevision!==workflow.revision||value.data.documentRevision!==revision) return json(res,{error:'Fixture generation version conflict'},409);
      if(workflowView().issues.some(issue=>issue.blocking)) return json(res,{error:'素材设置需要处理'},422);
      return json(res,{error:'真实图片生成服务尚未配置'},503);
    }
    if(url.searchParams.has('requestId')) {const id=url.searchParams.get('requestId');taskReads.push({kind:'STUDIO_GENERATION',id});return generations.has(id)?json(res,contracts.StudioGenerationView.parse(generations.get(id))):json(res,{error:'任务不存在'},404);}
    return json(res,{requests:[...generations.values()].map(value=>contracts.StudioGenerationView.parse(value))});
  }
  if(url.pathname===`/api/workspaces/${fixture.workspaceId}/notifications`) {
    if(req.headers['x-novart-user']!==fixture.userId||url.searchParams.get('scope')!=='studio') return json(res,{error:'Fixture notification scope mismatch'},403);
    const notifications=[...[...uploads.values()].map(task=>({id:'fixture-notification-'+task.taskId,kind:'STUDIO_UPLOAD',status:task.status,title:'合成上传任务提醒',createdAt:new Date().toISOString(),href:'/canvas?'+new URLSearchParams({workspaceId:fixture.workspaceId,projectId:fixture.projectId,taskId:task.taskId})})),...[...generations.values()].map(task=>({id:'fixture-notification-'+task.requestId,kind:'STUDIO_GENERATION',status:task.status,title:'合成生成失败提醒',createdAt:new Date().toISOString(),href:'/canvas?'+new URLSearchParams({workspaceId:fixture.workspaceId,projectId:fixture.projectId,requestId:task.requestId})}))];
    return json(res,{items:notifications});
  }
  if(url.pathname===material.url) {res.setHeader('Content-Type','image/png');return res.end(png);}
  return json(res,{error:'No fixture for this route'},404);
}
function check(name) {report.checks.push(name);}
async function fixtureSettled(condition) {const deadline=Date.now()+10000;while(!condition()){assert.ok(Date.now()<deadline,'Expected synthetic server state did not settle');await new Promise(resolve=>setTimeout(resolve,25));}}

(async()=>{
  const entry=path.join(directory,'entry.tsx');
  fs.writeFileSync(entry,`import React from '${path.join(repo,'apps/web/node_modules/react').replaceAll('\\','/')}';\nimport {createRoot} from '${path.join(repo,'apps/web/node_modules/react-dom/client').replaceAll('\\','/')}';\nimport {OwnedEditorClient} from '${path.join(repo,'apps/web/src/components/owned-canvas/OwnedEditorClient').replaceAll('\\','/')}';\nconst params=new URLSearchParams(location.search),task=params.get('taskId'),request=params.get('requestId');const initialTask=task&&!request?{kind:'STUDIO_UPLOAD' as const,id:task}:request&&!task?{kind:'STUDIO_GENERATION' as const,id:request}:undefined;const fixtureRoot=createRoot(document.getElementById('root')!);window.changeFixtureReadOnly=(readOnly:boolean)=>fixtureRoot.render(<OwnedEditorClient {...${JSON.stringify(fixture)}} readOnly={readOnly} initialTask={initialTask} projectName="交互回归"/>);window.changeFixtureReadOnly(false);`);
  await esbuild.build({entryPoints:[entry],outfile:path.join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
  const schemaEntry=path.join(directory,'schema.ts');
  fs.writeFileSync(schemaEntry,`export {WorkbenchDraftView,WorkbenchDraftSaveInput,StudioWorkflowSaveInput,StudioWorkflowView,StudioGenerationInput,StudioGenerationView} from '${path.join(repo,'packages/contracts/src/index').replaceAll('\\','/')}';\nexport {workflowAssets,workflowIssues,assertWorkflowSelection} from '${path.join(repo,'apps/web/src/lib/studio-workflow-codec').replaceAll('\\','/')}';`);
  await esbuild.build({entryPoints:[schemaEntry],outfile:path.join(directory,'schema.cjs'),bundle:true,platform:'node',format:'cjs',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],logLevel:'silent'});contracts=require(path.join(directory,'schema.cjs'));
  const css=spawnSync(process.execPath,[path.join(repo,'apps/web/node_modules/tailwindcss/lib/cli.js'),'-i',path.join(repo,'packages/ui/src/styles.css'),'-o',path.join(directory,'tokens.css'),'-c',path.join(repo,'apps/web/tailwind.config.ts'),'--content',path.join(repo,'apps/web/src/components/owned-canvas/*.{ts,tsx}')],{cwd:repo,encoding:'utf8',env:{...process.env,TEMP:directory,TMP:directory},timeout:60000});
  assert.equal(css.status,0,'Actual product styles must compile');
  server=http.createServer((req,res)=>handle(req,res).catch(()=>json(res,{error:'Fixture error'},500)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.NOVART_CHROMIUM_EXECUTABLE?{executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE}:{}),args:['--disable-background-networking']});
  const context=await browser.newContext({viewport:{width:1366,height:850},acceptDownloads:true});
  await context.route('**/*',route=>{const u=new URL(route.request().url());if(['http:','https:'].includes(u.protocol)&&u.origin!==origin){report.externalRequests.push(u.hostname);return route.abort();}return route.continue();});
  const page=await context.newPage(); page.on('pageerror',e=>report.errors.push(e.name));
  stage='open-owned-editor';await page.goto(origin+'/studio-editor');
  await page.getByTestId('owned-canvas').waitFor();
  const surface=page.getByTestId('owned-canvas');
  const bounds=await surface.boundingBox();assert.ok(bounds&&bounds.width>400&&bounds.height>300);
  const draw=async(label,x,y,w,h)=>{await page.getByRole('button',{name:label,exact:true}).click();await page.mouse.move(bounds.x+x,bounds.y+y);await page.mouse.down();await page.mouse.move(bounds.x+x+w,bounds.y+y+h,{steps:8});await page.mouse.up();};
  stage='draw-and-history';await draw('图形',160,130,150,110);await page.getByTestId('owned-canvas-item').waitFor();check('draw-rectangle');
  await page.getByRole('button',{name:'撤销',exact:true}).click();await assert.equal(await page.getByTestId('owned-canvas-item').count(),0);await page.getByRole('button',{name:'重做',exact:true}).click();assert.equal(await page.getByTestId('owned-canvas-item').count(),1);check('undo-redo');
  await draw('画笔',360,210,110,75);assert.equal(await page.getByTestId('owned-canvas-item').count(),2);check('freehand-stroke');
  stage='text-edit';await page.getByRole('button',{name:'文字',exact:true}).click();await page.mouse.click(bounds.x+160,bounds.y+330);const text=page.getByRole('textbox',{name:'编辑画布文字',exact:true});await text.waitFor();await text.fill('中文画布\n第二行');await text.press('Control+Enter');check('chinese-multiline-text');
  stage='persistent-upload';await page.locator('input[type=file]').first().setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:png});await page.locator('[data-testid="owned-canvas-item"][data-kind="image"]').waitFor();check('upload-and-insert');
  await page.getByRole('button',{name:'撤销',exact:true}).click();assert.equal(await page.locator('[data-kind="image"][data-owned-id]').count(),0);await page.getByRole('button',{name:'重做',exact:true}).click();assert.equal(await page.locator('[data-kind="image"][data-owned-id]').count(),1);check('uploaded-image-undo-redo');
  stage='save-and-reopen';const saveButton=page.getByRole('button',{name:'保存',exact:true});if(await saveButton.isEnabled())await saveButton.click();await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]').dataset.saveState==='saved');assert.equal(shapes().length,4);let before=canvas;
  await page.reload();await page.getByTestId('owned-canvas-item').nth(3).waitFor();assert.equal(canvas,before);check('mixed-document-save-reopen');
  stage='object-transforms';const rectangle=page.locator('[data-kind="shape"][data-owned-id]').first();await rectangle.click();
  const resize=page.getByRole('button',{name:'调整右下尺寸',exact:true});const corner=await resize.boundingBox();assert.ok(corner);const oldSize=await rectangle.boundingBox();await page.mouse.move(corner.x+corner.width/2,corner.y+corner.height/2);await page.mouse.down();await page.mouse.move(corner.x+55,corner.y+40,{steps:8});await page.mouse.up();const changedSize=await rectangle.boundingBox();assert.ok(changedSize.width>oldSize.width+20);check('pointer-resize');
  const rotation=page.getByRole('button',{name:'旋转选中元素',exact:true}),rotationBox=await rotation.boundingBox();const rotationStart=await rectangle.getAttribute('style');await page.mouse.move(rotationBox.x+rotationBox.width/2,rotationBox.y+rotationBox.height/2);await page.mouse.down();await page.mouse.move(rotationBox.x+120,rotationBox.y+100,{steps:8});await page.mouse.up();assert.notEqual(await rectangle.getAttribute('style'),rotationStart);check('pointer-rotate');
  await surface.focus();await page.keyboard.press('Control+a');assert.equal(await page.locator('[data-owned-id][data-selected="true"]').count(),4);await page.keyboard.press('ArrowRight');await page.keyboard.press('Delete');assert.equal(await page.getByTestId('owned-canvas-item').count(),0);await page.getByRole('button',{name:'撤销',exact:true}).click();assert.equal(await page.getByTestId('owned-canvas-item').count(),4);check('multiselect-nudge-delete-undo');
  await page.getByRole('button',{name:'放大',exact:true}).click();assert.match(await page.getByRole('button',{name:'恢复100%缩放'}).textContent(),/120%/);await page.getByRole('button',{name:'移动画布',exact:true}).click();const worldStyle=await page.locator('.oc-world').getAttribute('style');await page.mouse.move(bounds.x+600,bounds.y+450);await page.mouse.down();await page.mouse.move(bounds.x+650,bounds.y+480,{steps:8});await page.mouse.up();assert.notEqual(await page.locator('.oc-world').getAttribute('style'),worldStyle);check('pan-zoom');
  await page.getByRole('button',{name:'选择',exact:true}).click();if(await saveButton.isEnabled())await saveButton.click();await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]').dataset.saveState==='saved');before=canvas;
  stage='export';for(const label of ['导出SVG','导出PNG']) {await page.getByRole('button',{name:'导出',exact:true}).click();const event=page.waitForEvent('download');await page.getByRole('button',{name:label,exact:true}).click();const download=await event;const file=await download.path();const bytes=fs.readFileSync(file);assert.ok(bytes.length>50);if(label==='导出PNG') assert.equal(bytes.subarray(1,4).toString(),'PNG');else assert.match(bytes.toString(),/<svg/);check(label);}
  const waitDraft=async(expectedText)=>{if(expectedText!==undefined)await fixtureSettled(()=>draft.inputForm?.text===expectedText);await page.waitForFunction(()=>document.querySelector('[data-testid="owned-draft-status"]')?.dataset.draftState==='saved');};
  const waitWorkflow=()=>page.waitForFunction(()=>{const el=document.querySelector('[data-testid="owned-workflow"]');return el?.dataset.workflowState==='ready'&&el.dataset.workflowDirty==='false';});
  const saveWorkflow=async()=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/workflow'&&r.request().method()==='POST');await page.getByRole('button',{name:'保存用途',exact:true}).click();assert.equal((await response).status(),200);await waitWorkflow();};
  stage='draft-save-and-refresh';await waitDraft();await waitWorkflow();
  await page.getByRole('textbox',{name:'创作需求',exact:true}).fill('合成需求：保留中文\n刷新后继续编辑');
  await page.getByRole('combobox',{name:'图片比例',exact:true}).selectOption('16:9');await page.getByRole('combobox',{name:'图片画质',exact:true}).selectOption('2K');
  await waitDraft('合成需求：保留中文\n刷新后继续编辑');assert.deepEqual(draft.inputForm.sizeSelection,{ratioKey:'16:9',resolutionTier:'2K'});assert.ok(draftWrites>0);
  const savedDraftRevision=draft.revision;await page.reload();await waitDraft();await waitWorkflow();
  assert.equal(await page.getByRole('textbox',{name:'创作需求',exact:true}).inputValue(),draft.inputForm.text);assert.equal(await page.getByRole('combobox',{name:'图片比例',exact:true}).inputValue(),'16:9');assert.equal(await page.getByRole('combobox',{name:'图片画质',exact:true}).inputValue(),'2K');assert.equal(draft.revision,savedDraftRevision);check('draft-text-size-restored-without-empty-overwrite');
  stage='draft-ime';const prompt=page.getByRole('textbox',{name:'创作需求',exact:true}),beforeIme=draftWrites;
  await prompt.dispatchEvent('compositionstart',{data:''});await prompt.fill('zhongwenshuru');await page.waitForTimeout(900);assert.equal(draftWrites,beforeIme,'IME partial input must not be persisted');
  await prompt.fill('合成测试需求：中文输入完成');await prompt.dispatchEvent('compositionend',{data:'中文输入完成'});await waitDraft('合成测试需求：中文输入完成');check('ime-commits-before-draft-save');
  stage='workflow-mode-target-reference';await page.getByRole('button',{name:'读取最新设置',exact:true}).click();await waitWorkflow();
  const imageAsset=currentWorkflowAssets().assets[0];assert.ok(imageAsset?.valid,'The candidate must come from the saved canvas and persistent fixture material');const assetKey=JSON.stringify([imageAsset.shapeId,imageAsset.assetSha256]);
  await page.getByRole('combobox',{name:'创作方式',exact:true}).selectOption('modify');await page.getByRole('combobox',{name:'修改目标',exact:true}).selectOption(assetKey);
  await page.getByRole('combobox',{name:'添加画布素材用途',exact:true}).selectOption(assetKey);await page.getByRole('button',{name:'添加用途',exact:true}).click();
  assert.equal(await page.getByRole('checkbox',{name:'参与生成 1',exact:true}).isChecked(),false,'New reference must not automatically participate');
  await page.getByRole('combobox',{name:'素材用途 1',exact:true}).selectOption('ADAPTIVE');await page.getByRole('checkbox',{name:'参与生成 1',exact:true}).check();await saveWorkflow();
  assert.equal(workflow.mode,'modify');assert.deepEqual(workflow.target,{shapeId:imageAsset.shapeId,assetSha256:imageAsset.assetSha256});assert.equal(workflow.references[0].purpose,'ADAPTIVE');assert.equal(workflow.references[0].participates,true);assert.ok(workflowWrites>0);
  const savedWorkflowRevision=workflow.revision;await page.reload();await waitDraft();await waitWorkflow();
  assert.equal(await page.getByRole('combobox',{name:'创作方式',exact:true}).inputValue(),'modify');assert.equal(await page.getByRole('combobox',{name:'修改目标',exact:true}).inputValue(),assetKey);assert.equal(await page.getByRole('combobox',{name:'素材用途 1',exact:true}).inputValue(),'ADAPTIVE');assert.equal(await page.getByRole('checkbox',{name:'参与生成 1',exact:true}).isChecked(),true);assert.equal(workflow.revision,savedWorkflowRevision);check('workflow-mode-target-purpose-participation-reopen');
  stage='exact-output-frame-draft';await page.getByRole('combobox',{name:'创作方式',exact:true}).selectOption('generate');await page.getByRole('combobox',{name:'素材用途 1',exact:true}).selectOption('EXACT');
  await page.getByRole('button',{name:'按输出比例新建画框',exact:true}).click();const frameId=await page.getByRole('combobox',{name:'输出画框',exact:true}).inputValue();assert.match(frameId,/^shape:/);
  await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]').dataset.saveState==='saved');await fixtureSettled(()=>draft.inputForm?.outputFrameId===frameId);await waitDraft();await saveWorkflow();assert.equal(workflow.target,null);assert.equal(generationPosts,0,'Workflow setup must not automatically invoke generation');
  before=canvas;const baselineShapes=shapes().length;assert.equal(baselineShapes,5);await page.reload();await waitDraft();await waitWorkflow();assert.equal(await page.getByRole('combobox',{name:'输出画框',exact:true}).inputValue(),frameId);assert.equal(await page.getByRole('combobox',{name:'素材用途 1',exact:true}).inputValue(),'EXACT');assert.equal(canvas,before);check('exact-output-frame-restores-with-document-and-draft');
  stage='missing-provider';await page.getByRole('button',{name:'生成图片',exact:true}).click();await page.getByText('真实图片生成服务尚未配置',{exact:false}).waitFor();assert.equal(await page.getByRole('textbox',{name:'创作需求',exact:true}).inputValue(),'合成测试需求：中文输入完成');assert.equal(draft.inputForm.text,'合成测试需求：中文输入完成');assert.equal(generationPosts,1);assert.equal(generations.size,0);check('missing-provider-preserves-prompt-and-does-not-invent-task');
  stage='lost-generation-receipt-reload';
  const pendingKey='novart-owned-generation-pending-v1:'+ [fixture.workspaceId,fixture.userId,fixture.projectId].map(encodeURIComponent).join(':');
  const pendingRecord=await page.evaluate(key=>sessionStorage.getItem(key),pendingKey);assert.ok(pendingRecord,'Uncertain response must retain its original input journal');
  assert.deepEqual(JSON.parse(pendingRecord).intent,{mode:'generate',input:generationPostInputs[0]});
  const pendingBaseline={posts:generationPosts,draftWrites,workflowWrites,canvas};
  await page.reload();await waitDraft();await waitWorkflow();
  const confirmIntent=page.getByRole('button',{name:'确认上一份生成回执',exact:true});await confirmIntent.waitFor();
  assert.equal(await confirmIntent.isEnabled(),true);
  assert.equal(await page.getByRole('textbox',{name:'创作需求',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('combobox',{name:'创作方式',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('combobox',{name:'图片比例',exact:true}).isDisabled(),true);
  assert.equal(generationPosts,pendingBaseline.posts,'Reload must not retry an uncertain paid request automatically');
  assert.equal(draftWrites,pendingBaseline.draftWrites);assert.equal(workflowWrites,pendingBaseline.workflowWrites);assert.equal(canvas,pendingBaseline.canvas);
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),pendingKey),pendingRecord);
  check('uncertain-generation-reloads-frozen-without-auto-post');
  const confirmedResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/studio/generation'&&response.request().method()==='POST');
  await confirmIntent.click();assert.equal((await confirmedResponse).status(),503);await page.getByText('真实图片生成服务尚未配置',{exact:false}).waitFor();
  assert.equal(generationPosts,pendingBaseline.posts+1);assert.equal(generationPostInputs.length,2);
  assert.deepEqual(generationPostInputs[1],generationPostInputs[0],'Explicit confirmation must replay the complete original payload including mutation and revisions');
  assert.equal(generations.size,0,'A missing provider must never create a fabricated accepted task');
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),pendingKey),pendingRecord);
  check('explicit-generation-confirmation-replays-exact-mutation-and-payload');
  // Independent contexts exercise local journal failures without clearing the
  // actual pending intent in the first tab or inventing server acceptance.
  for(const scenario of ['corrupt','unavailable','quota','readonly']) {
    stage='generation-journal-'+scenario;
    const isolatedContext=await browser.newContext({viewport:{width:1366,height:850}});
    try {
      await isolatedContext.route('**/*',route=>{const u=new URL(route.request().url());if(['http:','https:'].includes(u.protocol)&&u.origin!==origin){report.externalRequests.push(u.hostname);return route.abort();}return route.continue();});
      await isolatedContext.addInitScript(({scenario,key,record})=>{
        if(scenario==='corrupt') sessionStorage.setItem(key,'{unreadable');
        if(scenario==='readonly') sessionStorage.setItem(key,record);
        if(scenario==='unavailable') Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('Unavailable','SecurityError');}});
        if(scenario==='quota') {
          const original=Storage.prototype.setItem;
          Storage.prototype.setItem=function(name,value){if(this===window.sessionStorage&&name===key)throw new DOMException('Unavailable','QuotaExceededError');return original.call(this,name,value);};
        }
      },{scenario,key:pendingKey,record:pendingRecord});
      const isolatedPage=await isolatedContext.newPage();isolatedPage.on('pageerror',error=>report.errors.push(error.name));
      const noPost=generationPosts;await isolatedPage.goto(origin+'/studio-editor');await isolatedPage.getByTestId('owned-canvas').waitFor();
      await isolatedPage.waitForFunction(()=>document.querySelector('[data-testid="owned-draft-status"]')?.dataset.draftState==='saved'&&document.querySelector('[data-testid="owned-workflow"]')?.dataset.workflowState==='ready');
      if(scenario==='quota') {
        await isolatedPage.getByRole('button',{name:'生成图片',exact:true}).click();
        await isolatedPage.getByText('创作确认记录未能保存',{exact:false}).waitFor();
        assert.equal(await isolatedPage.evaluate(key=>sessionStorage.getItem(key),pendingKey),null);
      } else if(scenario==='readonly') {
        await isolatedPage.evaluate(()=>window.changeFixtureReadOnly(true));
        await isolatedPage.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='确认上一份生成回执'&&button.disabled));
        assert.equal(await isolatedPage.evaluate(key=>sessionStorage.getItem(key),pendingKey),pendingRecord);
      } else {
        await isolatedPage.getByText(scenario==='corrupt'?'上一份创作的确认记录暂不可读':'浏览器暂不能保存创作确认记录',{exact:false}).waitFor();
        if(scenario==='corrupt')assert.equal(await isolatedPage.evaluate(key=>sessionStorage.getItem(key),pendingKey),'{unreadable');
      }
      assert.equal(await isolatedPage.getByRole('textbox',{name:'创作需求',exact:true}).isDisabled(),true);
      assert.equal(await isolatedPage.getByRole('button',{name:scenario==='readonly'?'确认上一份生成回执':'生成图片',exact:true}).isDisabled(),true);
      assert.equal(generationPosts,noPost,'Unsafe local storage or a read-only project must not post generation');
      assert.equal(generations.size,0);check('generation-journal-'+scenario+'-preserves-safety-without-post');
    } finally {await isolatedContext.close();}
  }
  if(process.env.NOVART_OWNED_SCREENSHOT)await page.screenshot({path:process.env.NOVART_OWNED_SCREENSHOT});
  stage='stable-no-sdk';await page.evaluate(()=>{const element=document.querySelector('[data-testid="owned-canvas"]');window.ownedStability={element,started:performance.now(),removed:false};window.ownedObserver=new MutationObserver(records=>{if(!element.isConnected||records.some(record=>[...record.removedNodes].some(node=>node===element||node instanceof Element&&node.contains(element))))window.ownedStability.removed=true;});window.ownedObserver.observe(document.body,{childList:true,subtree:true});});
  await page.waitForTimeout(15100);const stability=await page.evaluate(()=>{window.ownedObserver.disconnect();return {elapsed:performance.now()-window.ownedStability.started,removed:window.ownedStability.removed,same:window.ownedStability.element===document.querySelector('[data-testid="owned-canvas"]')};});assert.ok(stability.elapsed>=15000);assert.equal(stability.removed,false);assert.equal(stability.same,true);assert.equal(await page.getByRole('button',{name:'画笔',exact:true}).isVisible(),true);assert.equal(await surface.count(),1);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);assert.equal(await page.evaluate(()=>!!window.webpackChunk_lovartai_lovart_shell),false);check('canvas-and-toolbar-stable-15-seconds-without-sdk');
  stage='responsive';await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'收起面板',exact:true}).click();const small=await surface.boundingBox();assert.ok(small.width<=390&&small.width>=380);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const dock=await page.locator('.oc-dock').boundingBox();assert.ok(dock.x>=0&&dock.x+dock.width<=390);check('phone-layout');await page.setViewportSize({width:1366,height:850});
  stage='task-inbox-real-react-handoff';generations.set('fixture-generation',{mode:'generate',requestId:'fixture-generation',mutationId:crypto.randomUUID(),projectId:fixture.projectId,generationId:'fixture-generation-record',status:'FAILED',progress:null,expiresAt:new Date(Date.now()+60000).toISOString(),archiveExpiresAt:null,archiveProcessingExpiresAt:null,displayText:'合成任务，仅验证提醒入口',resultState:'NOT_REQUESTED',results:[],error:'合成失败回执，未调用真实 AI',archiveError:null,canRetryArchive:false});
  const taskOpenBaseline={canvas,writes,generationPosts,count:shapes().length};await page.goto(origin+'/studio');await page.waitForFunction(()=>receipts.some(r=>r.type==='nv-studio'&&r.action==='ready'));
  const readsBeforeInvalid=taskReads.length;await page.evaluate(identity=>{const frame=document.querySelector('iframe').contentWindow;const command={type:'novart-product-task-open',...identity,kind:'STUDIO_UPLOAD',taskId:'fixture-upload',token:'fixture-token'};frame.postMessage({...command,userId:'foreign-user'},location.origin);frame.dispatchEvent(new MessageEvent('message',{data:command,origin:location.origin,source:frame}));frame.dispatchEvent(new MessageEvent('message',{data:command,origin:'https://foreign.invalid',source:window}));},{...fixture});await page.waitForTimeout(250);assert.equal(taskReads.length,readsBeforeInvalid);check('task-focus-rejects-foreign-identity-origin-and-nonparent-source');
  for(const [kind,id] of [['STUDIO_UPLOAD','fixture-upload'],['STUDIO_GENERATION','fixture-generation']]) {
    await page.getByTestId('product-task-inbox-trigger').click();await page.locator(`[data-notification-id="fixture-notification-${id}"]`).getByRole('button',{name:'返回项目',exact:true}).click();
    await page.waitForFunction(({kind,id})=>receipts.some(receipt=>receipt.type==='novart-product-task-opened'&&receipt.kind===kind&&receipt.taskId===id&&receipt.ok===true),{kind,id});
    const child=page.frameLocator('iframe');await child.locator(`[data-task-id="${id}"]`).waitFor();assert.ok(taskReads.some(read=>read.id===id&&read.kind===kind));
    assert.equal(canvas,taskOpenBaseline.canvas);assert.equal(writes,taskOpenBaseline.writes);assert.equal(generationPosts,taskOpenBaseline.generationPosts);assert.equal(shapes().length,taskOpenBaseline.count);
  }
  check('actual-inbox-opens-upload-and-generation-tasks-without-auto-mutation');
  stage='direct-task-links';for(const [parameter,id] of [['taskId','fixture-upload'],['requestId','fixture-generation']]) {
    const reads=taskReads.length;await page.goto(origin+'/canvas?'+new URLSearchParams({workspaceId:fixture.workspaceId,projectId:fixture.projectId,[parameter]:id}));await page.locator(`[data-task-id="${id}"]`).waitFor();assert.ok(taskReads.slice(reads).some(read=>read.id===id));assert.equal(canvas,taskOpenBaseline.canvas);assert.equal(writes,taskOpenBaseline.writes);assert.equal(generationPosts,taskOpenBaseline.generationPosts);
  }
  check('direct-notification-links-open-existing-task-only');
  stage='parent-bridge';await page.goto(origin+'/shell');await page.waitForFunction(()=>receipts.some(r=>r.type==='nv-studio'&&r.action==='ready'));check('reviewed-shell-ready');
  const requestId=crypto.randomUUID();await page.evaluate(({requestId,projectId,material})=>document.querySelector('iframe').contentWindow.postMessage({type:'nv-studio',action:'insert-material',projectId,requestId,material},location.origin),{requestId,projectId:fixture.projectId,material});await page.waitForFunction(id=>receipts.some(r=>r.action==='insert-material-result'&&r.requestId===id&&r.status==='saved'),requestId);assert.equal(shapes().length,baselineShapes+1);const handoff=canvas;
  await page.evaluate(({requestId,projectId,material})=>document.querySelector('iframe').contentWindow.postMessage({type:'nv-studio',action:'insert-material',projectId,requestId,material},location.origin),{requestId,projectId:fixture.projectId,material});await page.waitForFunction(id=>receipts.filter(r=>r.action==='insert-material-result'&&r.requestId===id&&r.status==='saved').length===2,requestId);assert.equal(canvas,handoff);check('parent-material-handoff-saved-idempotently');before=canvas;
  const confirmation=crypto.randomUUID();await page.evaluate(({requestId,projectId})=>document.querySelector('iframe').contentWindow.postMessage({type:'nv-studio',action:'confirm-save',projectId,requestId},location.origin),{requestId:confirmation,projectId:fixture.projectId});await page.waitForFunction(id=>receipts.some(r=>r.action==='confirm-save-result'&&r.requestId===id&&r.status==='saved'),confirmation);check('parent-confirms-save');
  stage='handoff-turns-readonly';delayMaterials=350;const readonlyRequest=crypto.randomUUID();await page.evaluate(({requestId,projectId,material})=>{const frame=document.querySelector('iframe').contentWindow;frame.postMessage({type:'nv-studio',action:'insert-material',projectId,requestId,material},location.origin);setTimeout(()=>frame.changeFixtureReadOnly(true),100);},{requestId:readonlyRequest,projectId:fixture.projectId,material});await page.waitForFunction(id=>receipts.some(r=>r.action==='insert-material-result'&&r.requestId===id&&r.status==='failed'),readonlyRequest);assert.equal(canvas,before);assert.equal(shapes().length,baselineShapes+1);check('readonly-during-handoff-never-confirms-insertion');delayMaterials=0;
  stage='conflict';conflict=true;await page.goto(origin+'/studio-editor');await surface.waitFor();await draw('图形',180,140,120,80);await page.getByText('保存冲突',{exact:true}).waitFor();assert.equal(canvas,before);assert.equal(await page.getByRole('button',{name:'画笔',exact:true}).isDisabled(),true);check('save-conflict-preserves-server-and-local-content');conflict=false;
  stage='restore-failure';failRestore=true;const initialWrites=writes;await page.goto(origin+'/studio-editor');await page.getByText('合成恢复失败',{exact:false}).waitFor();await page.waitForTimeout(1500);assert.equal(writes,initialWrites);assert.equal(canvas,before);check('failed-restore-never-writes-empty');failRestore=false;
  stage='homepage-file-to-saved-owned-editor';canvas='';revision=0;uploads.clear();generations.clear();draft={projectId:fixture.projectId,revision:0,inputForm:null,updatedAt:null,referenceIssues:[]};workflow={projectId:fixture.projectId,revision:0,mode:'generate',target:null,references:[],updatedAt:null,issues:[]};await page.goto(origin+'/home-fixture');await page.waitForFunction(()=>homeStart.snapshot().loaded);await page.locator('#ns-home-brief').fill('首页带图测试');await page.locator('#hs-file-input').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:png});await page.waitForFunction(()=>homeStart.snapshot().attachmentCount===1);await page.locator('#ns-create').click();await page.waitForFunction(()=>homeStart.snapshot().submittedRequestId===null&&homeStart.snapshot().attachmentCount===0&&document.querySelector('iframe').contentDocument?.querySelector('[data-kind="image"]'),undefined,{timeout:45000});assert.equal(shapes().length,1);assert.ok(revision>=1);const homeSaved=canvas;const homeFrame=page.frames().find(frame=>new URL(frame.url()).pathname==='/studio-editor');assert.ok(homeFrame);await homeFrame.goto(origin+'/studio-editor');await homeFrame.getByTestId('owned-canvas-item').waitFor();assert.equal(canvas,homeSaved);check('homepage-file-handoff-clears-input-only-after-save-and-reopens');
  assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;
})().catch(error=>{report.passed=false;report.fatal={stage,name:error.name,message:String(error.message).slice(0,500)};process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
  const reportPath=process.env.NOVART_OWNED_REPORT;if(reportPath)fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  assert.equal(path.dirname(directory),temporaryRoot);fs.rmSync(directory,{recursive:true,force:true});
});

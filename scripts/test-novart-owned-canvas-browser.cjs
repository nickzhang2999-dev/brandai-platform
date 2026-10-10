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
let stage = 'build-fixture', browser, server;
let canvas = '', revision = 0, readOnly = false, writes = 0, failRestore = false, conflict = false, delayMaterials = 0;
const uploads = new Map();
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
async function body(req) {const chunks=[];for await(const c of req) chunks.push(c);return Buffer.concat(chunks);}
async function handle(req,res) {
  const url = new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/app.js'||url.pathname==='/app.css') {res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript':'text/css');return res.end(url.pathname.endsWith('.css')?Buffer.concat([fs.readFileSync(path.join(directory,'tokens.css')),fs.readFileSync(path.join(directory,'app.css'))]):fs.readFileSync(path.join(directory,'app.js')));}
  if(url.pathname.startsWith('/fonts/')) {const file=path.resolve(repo,'apps/web/public',url.pathname.slice(1));if(file.startsWith(path.join(repo,'apps/web/public/fonts')+path.sep)&&fs.existsSync(file))return res.end(fs.readFileSync(file));res.writeHead(404);return res.end();}
  if(url.pathname==='/shell') {res.setHeader('Content-Type','text/html');return res.end('<html><body style="margin:0"><iframe style="width:100vw;height:100vh;border:0" src="/studio-editor"></iframe><script>window.receipts=[];addEventListener("message",e=>{if(e.origin===location.origin)receipts.push(e.data)});</script></body></html>');}
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
  if(url.pathname==='/studio-editor') {res.setHeader('Content-Type','text/html');return res.end('<html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}
  if(url.pathname==='/compare/api/create'&&req.method==='POST') {const value=JSON.parse((await body(req)).toString());assert.ok(value.requestId);return json(res,{projectId:fixture.projectId,projectName:value.projectName});}
  if(url.pathname.includes('/editor-document')) {
    if(req.method==='GET') return failRestore ? json(res,{error:'合成恢复失败'},503) : json(res,documentView());
    const value=JSON.parse((await body(req)).toString());
    if(readOnly) return json(res,{error:'只读项目'},403);
    if(conflict || value.revision!==revision) return json(res,{error:'画布已在其他页面更新',code:'DOCUMENT_CONFLICT'},409);
    canvas=value.canvas;revision++;writes++;return json(res,documentView());
  }
  if(url.pathname==='/workflow') return json(res,{projectId:fixture.projectId,revision:0,mode:'generate',target:null,references:[],updatedAt:null,issues:[]});
  if(url.pathname==='/studio/materials') {if(delayMaterials) await new Promise(resolve=>setTimeout(resolve,delayMaterials));return json(res,uploads.size?[material]:[]);}
  if(url.pathname==='/studio/material-upload') {
    if(req.method==='POST') {
      const raw=(await body(req)).toString('latin1');
      const mutationId=raw.match(/name="mutationId"\r\n\r\n([^\r]+)/)?.[1]; assert.ok(mutationId);
      const task={taskId:'fixture-upload',projectId:fixture.projectId,mutationId,status:'SUCCEEDED',progress:100,expiresAt:new Date(Date.now()+60000).toISOString(),material};
      uploads.set(task.taskId,task);return json(res,task,202);
    }
    return json(res,url.searchParams.has('taskId')?uploads.get(url.searchParams.get('taskId')):{tasks:[...uploads.values()]});
  }
  if(url.pathname==='/studio/generation') return req.method==='POST' ? json(res,{error:'真实图片生成服务尚未配置'},503) : json(res,{requests:[]});
  if(url.pathname===material.url) {res.setHeader('Content-Type','image/png');return res.end(png);}
  return json(res,{error:'No fixture for this route'},404);
}
function check(name) {report.checks.push(name);}

(async()=>{
  const entry=path.join(directory,'entry.tsx');
  fs.writeFileSync(entry,`import React from '${path.join(repo,'apps/web/node_modules/react').replaceAll('\\','/')}';\nimport {createRoot} from '${path.join(repo,'apps/web/node_modules/react-dom/client').replaceAll('\\','/')}';\nimport {OwnedEditorClient} from '${path.join(repo,'apps/web/src/components/owned-canvas/OwnedEditorClient').replaceAll('\\','/')}';\nconst fixtureRoot=createRoot(document.getElementById('root')!);window.changeFixtureReadOnly=(readOnly:boolean)=>fixtureRoot.render(<OwnedEditorClient {...${JSON.stringify(fixture)}} readOnly={readOnly} projectName="交互回归"/>);window.changeFixtureReadOnly(false);`);
  await esbuild.build({entryPoints:[entry],outfile:path.join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
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
  stage='missing-provider';await page.locator('textarea').last().fill('合成测试需求');await page.getByRole('button',{name:'生成图片',exact:true}).click();await page.getByText('真实图片生成服务尚未配置',{exact:false}).waitFor();assert.equal(await page.locator('textarea').last().inputValue(),'合成测试需求');check('missing-provider-preserves-prompt');
  if(process.env.NOVART_OWNED_SCREENSHOT)await page.screenshot({path:process.env.NOVART_OWNED_SCREENSHOT});
  stage='stable-no-sdk';await page.waitForTimeout(6500);assert.equal(await surface.count(),1);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);assert.equal(await page.evaluate(()=>!!window.webpackChunk_lovartai_lovart_shell),false);check('stable-without-sdk');
  stage='responsive';await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'收起面板',exact:true}).click();const small=await surface.boundingBox();assert.ok(small.width<=390&&small.width>=380);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const dock=await page.locator('.oc-dock').boundingBox();assert.ok(dock.x>=0&&dock.x+dock.width<=390);check('phone-layout');await page.setViewportSize({width:1366,height:850});
  stage='parent-bridge';await page.goto(origin+'/shell');await page.waitForFunction(()=>receipts.some(r=>r.type==='nv-studio'&&r.action==='ready'));check('reviewed-shell-ready');
  const requestId=crypto.randomUUID();await page.evaluate(({requestId,projectId,material})=>document.querySelector('iframe').contentWindow.postMessage({type:'nv-studio',action:'insert-material',projectId,requestId,material},location.origin),{requestId,projectId:fixture.projectId,material});await page.waitForFunction(id=>receipts.some(r=>r.action==='insert-material-result'&&r.requestId===id&&r.status==='saved'),requestId);assert.equal(shapes().length,5);const handoff=canvas;
  await page.evaluate(({requestId,projectId,material})=>document.querySelector('iframe').contentWindow.postMessage({type:'nv-studio',action:'insert-material',projectId,requestId,material},location.origin),{requestId,projectId:fixture.projectId,material});await page.waitForFunction(id=>receipts.filter(r=>r.action==='insert-material-result'&&r.requestId===id&&r.status==='saved').length===2,requestId);assert.equal(canvas,handoff);check('parent-material-handoff-saved-idempotently');before=canvas;
  const confirmation=crypto.randomUUID();await page.evaluate(({requestId,projectId})=>document.querySelector('iframe').contentWindow.postMessage({type:'nv-studio',action:'confirm-save',projectId,requestId},location.origin),{requestId:confirmation,projectId:fixture.projectId});await page.waitForFunction(id=>receipts.some(r=>r.action==='confirm-save-result'&&r.requestId===id&&r.status==='saved'),confirmation);check('parent-confirms-save');
  stage='handoff-turns-readonly';delayMaterials=350;const readonlyRequest=crypto.randomUUID();await page.evaluate(({requestId,projectId,material})=>{const frame=document.querySelector('iframe').contentWindow;frame.postMessage({type:'nv-studio',action:'insert-material',projectId,requestId,material},location.origin);setTimeout(()=>frame.changeFixtureReadOnly(true),100);},{requestId:readonlyRequest,projectId:fixture.projectId,material});await page.waitForFunction(id=>receipts.some(r=>r.action==='insert-material-result'&&r.requestId===id&&r.status==='failed'),readonlyRequest);assert.equal(canvas,before);assert.equal(shapes().length,5);check('readonly-during-handoff-never-confirms-insertion');delayMaterials=0;
  stage='conflict';conflict=true;await page.goto(origin+'/studio-editor');await surface.waitFor();await draw('图形',180,140,120,80);await page.getByText('保存冲突',{exact:true}).waitFor();assert.equal(canvas,before);assert.equal(await page.getByRole('button',{name:'画笔',exact:true}).isDisabled(),true);check('save-conflict-preserves-server-and-local-content');conflict=false;
  stage='restore-failure';failRestore=true;const initialWrites=writes;await page.goto(origin+'/studio-editor');await page.getByText('合成恢复失败',{exact:false}).waitFor();await page.waitForTimeout(1500);assert.equal(writes,initialWrites);assert.equal(canvas,before);check('failed-restore-never-writes-empty');failRestore=false;
  stage='homepage-file-to-saved-owned-editor';canvas='';revision=0;uploads.clear();await page.goto(origin+'/home-fixture');await page.waitForFunction(()=>homeStart.snapshot().loaded);await page.locator('#ns-home-brief').fill('首页带图测试');await page.locator('#hs-file-input').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:png});await page.waitForFunction(()=>homeStart.snapshot().attachmentCount===1);await page.locator('#ns-create').click();await page.waitForFunction(()=>homeStart.snapshot().submittedRequestId===null&&homeStart.snapshot().attachmentCount===0&&document.querySelector('iframe').contentDocument?.querySelector('[data-kind="image"]'),undefined,{timeout:45000});assert.equal(shapes().length,1);assert.ok(revision>=1);const homeSaved=canvas;const homeFrame=page.frames().find(frame=>new URL(frame.url()).pathname==='/studio-editor');assert.ok(homeFrame);await homeFrame.goto(origin+'/studio-editor');await homeFrame.getByTestId('owned-canvas-item').waitFor();assert.equal(canvas,homeSaved);check('homepage-file-handoff-clears-input-only-after-save-and-reopens');
  report.passed=true;
})().catch(error=>{report.passed=false;report.fatal={stage,name:error.name,message:String(error.message).slice(0,500)};process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
  const reportPath=process.env.NOVART_OWNED_REPORT;if(reportPath)fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  assert.equal(path.dirname(directory),temporaryRoot);fs.rmSync(directory,{recursive:true,force:true});
});

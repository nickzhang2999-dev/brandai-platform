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
const layersOnly = process.env.NOVART_OWNED_LAYERS_ONLY === '1';
const layerFailureOnly = process.env.NOVART_OWNED_LAYERS_FAILURE_ONLY === '1';
const layerQueueRecovery = process.env.NOVART_OWNED_LAYERS_QUEUE_RECOVERY === '1';
const experienceOnly = process.env.NOVART_OWNED_EXPERIENCE_ONLY === '1';
const brandOnly = process.env.NOVART_OWNED_BRAND_ONLY === '1';
const copywritingOnly = process.env.NOVART_OWNED_COPYWRITING_ONLY === '1';
const targetOnly = process.env.NOVART_OWNED_TARGET_ONLY === '1';
const layerRepairOnly = process.env.NOVART_OWNED_LAYER_REPAIR_ONLY === '1';
const copywritingTasks = []; let copywritingPosts = 0;
const temporaryRoot = path.join(repo, '.novart-build', 'temporary');
fs.mkdirSync(temporaryRoot, {recursive: true});
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'owned-browser-'));
assert.equal(path.dirname(directory), temporaryRoot);
const esbuildPackage = fs.readdirSync(path.join(repo, 'node_modules/.pnpm')).find(n => n.startsWith('esbuild@0.28.'));
assert.ok(esbuildPackage, 'Use the already installed build dependency');
const esbuild = require(path.join(repo, 'node_modules/.pnpm', esbuildPackage, 'node_modules/esbuild'));
const fixture = {workspaceId:'fixture-workspace', projectId:'fixture-project', userId:'fixture-user'};
const report = {isolated:true, realBackend:false, realProvider:false, realAuthentication:false, providerCalls:0,
  fixtureScope:'Loopback in-memory HTTP persistence; actual production React editor and styles',
  checks:[], externalRequests:[], errors:[]};
let stage = 'build-fixture', browser, server, contracts;
const writingFixture = require('./writing-workbench-fixture.cjs').createWritingFixture({contracts:()=>contracts,json,body,onGenerate:()=>{copywritingPosts++;}});
let canvas = '', revision = 0, readOnly = false, writes = 0, failRestore = false, conflict = false, delayMaterials = 0, delayDocument = 0, delayConversation = 0, delayWorkflow = 0;
let draft = {projectId:fixture.projectId,revision:0,inputForm:null,updatedAt:null,referenceIssues:[]};
let conversationDraft = null, conversationPosts = [], conversationMessages = [];
let materialDelays = [], materialReads = 0, conversationWrites = 0;
let workflow = {projectId:fixture.projectId,revision:0,mode:'generate',target:null,references:[],updatedAt:null,issues:[]};
let draftWrites = 0, workflowWrites = 0, generationPosts = 0;
const uploads = new Map(), generations = new Map(), taskReads = [], generationPostInputs = [];
const decompositions = new Map(), decompositionPostInputs = [], layerTaskReads = [], layerDownloads = [];
const experienceAssets = new Map(), failedExperienceAssets = new Set();
let decompositionPosts = 0, failLayerDownload = layersOnly;
let layerRecoveryPosts = 0;
let layerReadFailures = 0;
const imageToolInputs = [];
let imageToolResponse = 'lost', releaseImageTool;
function pngChunk(type, value) {
  const payload=Buffer.concat([Buffer.from(type),value]), result=Buffer.alloc(value.length+12);let crc=0xffffffff;
  for(const byte of payload) {crc^=byte;for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  result.writeUInt32BE(value.length);payload.copy(result,4);result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4);return result;
}
const imageHeader=Buffer.alloc(13);imageHeader.writeUInt32BE(1,0);imageHeader.writeUInt32BE(1,4);imageHeader[8]=8;imageHeader[9]=6;
function fixturePng(width,height,pixel) {
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const rgba=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++)for(let x=0;x<width;x++)Buffer.from(pixel(x,y)).copy(rgba,y*(width*4+1)+1+x*4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',zlib.deflateSync(rgba)),pngChunk('IEND',Buffer.alloc(0))]);
}
const foregroundPixel=(x,y)=>x>=3&&x<7&&y>=2&&y<5?[220,70,90,255]:[0,0,0,0];
const png=(layersOnly||layerRepairOnly)?fixturePng(12,8,(x,y)=>foregroundPixel(x,y)[3]?foregroundPixel(x,y):[124,92,255,255]):Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',imageHeader),pngChunk('IDAT',zlib.deflateSync(Buffer.from([0,124,92,255,255]))),pngChunk('IEND',Buffer.alloc(0))]);
const assetSha256 = crypto.createHash('sha256').update(png).digest('hex');
const material = {id:'fixture-asset',assetId:'fixture-asset',assetSha256,fileName:'fixture.png',mimeType:'image/png',sizeBytes:png.length,width:(layersOnly||layerRepairOnly)?12:1,height:(layersOnly||layerRepairOnly)?8:1,url:'/api/workspaces/fixture-workspace/assets/fixture-asset/raw',kind:'image'};
const layerPngs=[fixturePng(12,8,()=>[124,92,255,255]),fixturePng(12,8,foregroundPixel)];
const layerResults=layerPngs.map((bytes,order)=>({assetId:'fixture-layer-'+order,assetSha256:crypto.createHash('sha256').update(bytes).digest('hex'),mimeType:'image/png',width:12,height:8,order,sizeBytes:bytes.length,url:`/api/workspaces/${fixture.workspaceId}/assets/fixture-layer-${order}/raw`,alphaBounds:order?{left:3,top:2,width:4,height:3}:{left:0,top:0,width:12,height:8},inkCoverage:order?12/96:1}));
function json(res, value, status=200) {res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function documentView() {return {workspaceId:fixture.workspaceId,projectId:fixture.projectId,format:'novart-native-v1',canvas,revision,checksum:canvas?crypto.createHash('sha256').update(canvas).digest('hex'):null,updatedAt:revision?new Date().toISOString():null,readOnly};}
function records() {return canvas ? JSON.parse(zlib.gunzipSync(Buffer.from(canvas.slice('SHAKKERDATA://'.length),'base64'))).tldrawSnapshot.document.store : {};}
function shapes() {return Object.values(records()).filter(r=>r.typeName==='shape');}
function currentWorkflowAssets() {return contracts.workflowAssets(fixture.projectId,canvas,[...(uploads.size?[{sha256:assetSha256,url:material.url,mimeType:material.mimeType}]:[]),...[...experienceAssets.values()].map(value=>({sha256:value.assetSha256,url:value.url,mimeType:value.mimeType}))]);}
function workflowView() {const assets=currentWorkflowAssets();return contracts.StudioWorkflowView.parse({...workflow,issues:[...assets.issues,...contracts.workflowIssues(workflow,assets.assets)]});}
async function body(req) {const chunks=[];for await(const c of req) chunks.push(c);return Buffer.concat(chunks);}
async function handle(req,res) {
  const url = new URL(req.url,'http://127.0.0.1');
  if(layerRepairOnly && url.pathname===`/api/workspaces/${fixture.workspaceId}/projects/${fixture.projectId}/studio-image-tools`) {
    if(req.method==='GET')return json(res,{revision:'studio-image-tools-r1',removeBackground:{available:false,reason:'Not enabled in this fixture'},inpaint:{available:true,reason:null},maskConvention:'white-edit-black-preserve',maxMaskBytes:1048576,maxPixels:16777216});
    const input=contracts.StudioImageToolInput.parse(JSON.parse((await body(req)).toString()));imageToolInputs.push(input);
    assert.equal(input.decompositionRequestId,'fixture-decomposition');assert.equal(input.target.shapeId,'shape:repair-source');assert.equal(input.target.assetSha256,material.assetSha256);
    if(imageToolResponse==='lost'){imageToolResponse='accepted';res.writeHead(202,{'Content-Type':'application/json'});res.end('{"incomplete":');return;}
    if(imageToolResponse==='hold'){await new Promise(resolve=>{releaseImageTool=resolve;});return json(res,{error:'Fixture old-scope rejection'},422);}
    return json(res,contracts.StudioGenerationView.parse({mode:'modify',sourceShapeId:input.target.shapeId,requestId:'fixture-repair',mutationId:input.mutationId,projectId:fixture.projectId,generationId:'fixture-repair-generation',status:'PENDING',progress:null,expiresAt:'2099-01-01T00:00:00.000Z',archiveExpiresAt:null,archiveProcessingExpiresAt:null,displayText:input.instruction,resultState:'NOT_REQUESTED',results:[],error:null,archiveError:null,canRetryArchive:false}),202);
  }
  if(url.pathname.startsWith('/api/')&&url.pathname.includes('/studio-writing')) return writingFixture.handle(req,res,url);
  if(url.pathname.endsWith('/studio-copywriting')) {
    if(req.method==='POST') {const input=JSON.parse((await body(req)).toString());copywritingPosts++;let task=copywritingTasks.find(t=>t.mutationId===input.mutationId);
      if(!task){task={id:'copy-fixture-'+copywritingPosts,mutationId:input.mutationId,prompt:input.prompt,status:'SUCCEEDED',createdAt:new Date().toISOString(),error:null,result:{candidates:[{title:'交互测试标题',body:'测试夹具正文，仅用于编辑、撤销和刷新恢复检查。'}],model:'fixture',inputTokens:0,outputTokens:0,latencyMs:0}};copywritingTasks.unshift(task);}return json(res,task,202);}
    return json(res,{enabled:copywritingOnly,tasks:copywritingTasks});
  }
  if (/^\/brand\/deepflare-(?:logo(?:-dark)?|mark|icon)\.svg$/.test(url.pathname)) {res.setHeader('content-type', 'image/svg+xml'); return res.end(fs.readFileSync(path.join(repo, 'apps/web/public', url.pathname)));}
  if(url.pathname==='/app.js'||url.pathname==='/app.css') {res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript':'text/css');return res.end(url.pathname.endsWith('.css')?Buffer.concat([fs.readFileSync(path.join(directory,'tokens.css')),fs.readFileSync(path.join(directory,'app.css'))]):fs.readFileSync(path.join(directory,'app.js')));}
  if(url.pathname.startsWith('/brand/')) {const file=path.resolve(repo,'apps/web/public',url.pathname.slice(1));if(file.startsWith(path.join(repo,'apps/web/public/brand')+path.sep)&&fs.existsSync(file)){res.setHeader('Content-Type','image/svg+xml');return res.end(fs.readFileSync(file));}res.writeHead(404);return res.end();}
  if(url.pathname.startsWith('/fonts/')) {const file=path.resolve(repo,'apps/web/public',url.pathname.slice(1));if(file.startsWith(path.join(repo,'apps/web/public/fonts')+path.sep)&&fs.existsSync(file))return res.end(fs.readFileSync(file));res.writeHead(404);return res.end();}
  if(url.pathname==='/shell'||url.pathname==='/studio') {res.setHeader('Content-Type','text/html');return res.end(`<html><head><meta charset="utf-8"></head><body style="margin:0"><div class="ns-sidebar-bottom" style="position:fixed;bottom:20px;left:12px;z-index:1000;background:white"></div><div class="ns-frame-slot" data-active="true"><iframe data-testid="studio-canvas-frame" data-project-id="${fixture.projectId}" data-ready="false" style="width:100vw;height:100vh;border:0" src="/studio-editor"></iframe></div><script>window.__NOVART_PRODUCT__={workspaceId:${JSON.stringify(fixture.workspaceId)},user:{id:${JSON.stringify(fixture.userId)}}};window.receipts=[];addEventListener('message',e=>{const frame=document.querySelector('iframe');if(e.origin===location.origin&&e.source===frame.contentWindow){receipts.push(e.data);if(e.data?.type==='nv-studio'&&e.data.action==='ready')frame.dataset.ready='true';}});</script><script src="/product-task-inbox.js"></script><script>NovartProductTaskInbox.start();</script></body></html>`);}
  if(url.pathname==='/product-task-inbox.js') {res.setHeader('Content-Type','application/javascript');return res.end(fs.readFileSync(path.join(repo,'deploy/novart/studio/novart-product-task-inbox.js')));}
  if(url.pathname==='/owned-home-start.js') {res.setHeader('Content-Type','application/javascript');return res.end(fs.readFileSync(path.join(repo,'deploy/novart/studio/novart-owned-home-start.js')));}
  if(url.pathname==='/home-fixture') {
    res.setHeader('Content-Type','text/html');return res.end(`<html><head><meta charset="utf-8"></head><body>
      <button id="ns-mode-image">图片创作</button><button id="ns-mode-copywriting">文案创作</button><div id="ns-composer"><textarea id="ns-home-brief"></textarea><button id="hs-pick">添加图片</button><input id="hs-file-input" type="file" multiple><button id="ns-create"><span>创建项目</span></button><button id="ns-create-blank">空白</button></div>
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
  if(url.pathname==='/studio-editor'||url.pathname==='/canvas'||url.pathname==='/studio-writing') {res.setHeader('Content-Type','text/html');return res.end('<html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}
  if(url.pathname==='/compare/api/create'&&req.method==='POST') {const value=JSON.parse((await body(req)).toString());assert.ok(value.requestId);return json(res,{projectId:fixture.projectId,projectName:value.projectName});}
  if(url.pathname.includes('/editor-document')) {
    if(req.method==='GET') return failRestore ? json(res,{error:'合成恢复失败'},503) : json(res,documentView());
    const value=JSON.parse((await body(req)).toString());
    if(delayDocument) await new Promise(resolve=>setTimeout(resolve,delayDocument));
    if(readOnly) return json(res,{error:'只读项目'},403);
    if(conflict || value.revision!==revision) return json(res,{error:'画布已在其他页面更新',code:'DOCUMENT_CONFLICT'},409);
    canvas=value.canvas;revision++;writes++;return json(res,documentView());
  }
  if(['/studio/draft','/workflow','/workflow/assets','/studio/generation','/studio/decomposition'].includes(url.pathname)
    && (url.searchParams.get('workspaceId')!==fixture.workspaceId||url.searchParams.get('projectId')!==fixture.projectId||req.headers['x-novart-user']!==fixture.userId)) return json(res,{error:'Fixture identity scope mismatch'},403);
  if(url.pathname==='/studio/draft') {
    if(req.method==='GET') return json(res,contracts.WorkbenchDraftView.parse(draft));
    const value=contracts.WorkbenchDraftSaveInput.safeParse(JSON.parse((await body(req)).toString()));
    if(!value.success||value.data.projectId!==fixture.projectId) return json(res,{error:'Fixture draft input rejected'},422);
    if(readOnly) return json(res,{error:'只读项目'},403);
    if(value.data.revision!==draft.revision) return json(res,{error:'草稿已在其他页面更新'},409);
    draft=contracts.WorkbenchDraftView.parse({...value.data,revision:draft.revision+1,updatedAt:Date.now(),referenceIssues:[]});draftWrites++;return json(res,draft);
  }
  if(url.pathname===`/api/workspaces/${fixture.workspaceId}/projects/${fixture.projectId}/studio-conversation`) {
    if(req.headers['x-novart-user']!==fixture.userId) return json(res,{error:'Fixture conversation identity rejected'},403);
    if(req.method==='GET'){if(delayConversation)await new Promise(resolve=>setTimeout(resolve,delayConversation));return json(res,contracts.StudioConversationPage.parse({messages:conversationMessages,nextCursor:null,draft:conversationDraft}));}
    if(req.method==='PUT') { const input=contracts.StudioConversationDraftInput.parse(JSON.parse((await body(req)).toString())); if(readOnly)return json(res,{error:'只读项目'},403); if(input.revision!==(conversationDraft?.revision??0))return json(res,{error:'对话草稿已更新'},409); conversationDraft=contracts.StudioConversationDraft.parse({...input,revision:input.revision+1});conversationWrites++;return json(res,conversationDraft); }
    const input=contracts.StudioConversationInput.parse(JSON.parse((await body(req)).toString()));conversationPosts.push(input);
    if(input.homeStart){const old=conversationMessages.find(row=>row.mutationId===input.mutationId);if(old)return json(res,old,202);const row=contracts.StudioConversationMessage.parse({messageId:'fixture-home-message',mutationId:input.mutationId,projectId:fixture.projectId,text:input.text,references:input.references,status:'FAILED',intent:null,generation:null,error:'Interaction fixture intentionally has no AI provider',clarification:null,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+360000).toISOString()});conversationMessages.push(row);return json(res,row,202);}
    return json(res,{error:'真实模型未配置，不接受fixture生成'},503);
  }
  if(url.pathname===`/api/workspaces/${fixture.workspaceId}/studio-brand-materials`) return json(res,{items:uploads.size?[{assetId:material.assetId,fileName:material.fileName,mimeType:material.mimeType,sizeBytes:material.sizeBytes,libraryKind:'MATERIAL',createdAt:new Date().toISOString(),url:material.url,material}]:[],nextCursor:null});
  if(url.pathname===`/api/workspaces/${fixture.workspaceId}/studio-brand-materials/upload`) {
    if(req.method==='GET')return json(res,{tasks:[]});
    return json(res,{error:'当前旧回归只使用原项目上传，品牌上传独立测试'},422);
  }
  if(url.pathname===`/api/workspaces/${fixture.workspaceId}/studio-brand-materials/${material.assetId}`) {
    const input=req.method==='POST'?JSON.parse((await body(req)).toString()):{operation:'verify'};
    if(input.operation==='verify')return json(res,{assetId:material.assetId,status:'SUCCEEDED',material},202);
    assert.equal(input.operation,'link');assert.equal(input.projectId,fixture.projectId);assert.equal(input.assetSha256,assetSha256);return json(res,material);
  }
  if(url.pathname==='/workflow/assets') return json(res,currentWorkflowAssets());
  if(url.pathname==='/workflow') {
    if(req.method==='GET'){if(delayWorkflow)await new Promise(resolve=>setTimeout(resolve,delayWorkflow));return json(res,workflowView());}
    const value=contracts.StudioWorkflowSaveInput.safeParse(JSON.parse((await body(req)).toString()));
    if(!value.success||value.data.projectId!==fixture.projectId) return json(res,{error:'Fixture workflow input rejected'},422);
    if(readOnly) return json(res,{error:'只读项目'},403);
    if(value.data.revision!==workflow.revision) return json(res,{error:'素材设置已在其他页面更新'},409);
    // Reuse the real document/material codec and selection guard. A choice
    // cannot become valid solely because the synthetic UI submitted an ID.
    if(!contracts.assertWorkflowSelection(value.data,workflow,currentWorkflowAssets().assets)) return json(res,{error:'素材不属于已保存画布'},422);
    workflow={...value.data,revision:workflow.revision+1,updatedAt:Date.now(),issues:[]};workflowWrites++;return json(res,workflowView());
  }
  if(url.pathname==='/studio/materials') {materialReads++;const wait=materialDelays.length?materialDelays.shift():delayMaterials;if(wait) await new Promise(resolve=>setTimeout(resolve,wait));return json(res,[...(uploads.size?[material]:[]),...experienceAssets.values()]);}
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
  if(url.pathname==='/studio/decomposition/retry-archive' && req.method==='POST') {
    const input=JSON.parse((await body(req)).toString()),value=decompositions.get(input.requestId);
    assert.equal(input.projectId,fixture.projectId);assert.ok(layerQueueRecovery && value?.view.canRetryArchive);
    layerRecoveryPosts++;value.reads=0;value.recovered=true;
    value.view={...value.view,status:'RUNNING',error:null,canRetryArchive:false,expiresAt:new Date(Date.now()+360000).toISOString()};
    return json(res,contracts.StudioDecompositionView.parse(value.view),202);
  }
  if(url.pathname==='/studio/decomposition') {
    if(req.method==='POST') {
      decompositionPosts++;const input=JSON.parse((await body(req)).toString());decompositionPostInputs.push(input);
      const parsed=contracts.StudioDecompositionInput.safeParse(input);
      if(!parsed.success||parsed.data.projectId!==fixture.projectId) return json(res,{error:'Fixture decomposition input rejected'},422);
      const value=parsed.data,source=records()[value.sourceShapeId];
      if(value.documentRevision!==revision||!source||source.type!=='c-image'||source.meta?.novartAssetId!==value.assetId||source.meta?.novartAssetSha256!==value.assetSha256||value.assetId!==material.assetId||value.assetSha256!==assetSha256||value.layerCount!==2) return json(res,{error:'Fixture decomposition saved source mismatch'},409);
      const replay=[...decompositions.values()].find(item=>item.view.mutationId===value.mutationId);
      if(replay)return json(res,replay.view,202);
      const {intent:_intent,...snapshot}=value;
      const view=contracts.StudioDecompositionView.parse({requestId:'fixture-decomposition',...snapshot,sourceWidth:12,sourceHeight:8,status:'PENDING',error:null,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+6*60000).toISOString(),archiveExpiresAt:null,canRetryArchive:false,layers:[]});
      decompositions.set(view.requestId,{view,reads:0});layerTaskReads.push({requestId:view.requestId,status:'PENDING',method:'POST'});return json(res,view,202);
    }
    if(layerQueueRecovery && !layerReadFailures && [...decompositions.values()].some(value=>value.view.status==='RUNNING')) {
      layerReadFailures++;return json(res,{error:'状态查询暂时中断，请稍后查看'},503);
    }
    function read(value) {
      if(['PENDING','RUNNING'].includes(value.view.status)) {value.reads++;const failed=layerFailureOnly&&!value.recovered;value.view={...value.view,status:value.reads>=2?(failed?'FAILED':'SUCCEEDED'):'RUNNING',layers:value.reads>=2&&!failed?layerResults:[],error:value.reads>=2&&failed?(layerQueueRecovery?'分层等待超时，原任务已保留，可检查已有结果。':'图片内容分析服务拒绝了请求。（上游 HTTP 400）未调用分层模型，原图片保留。'):null,
        canRetryArchive:value.reads>=2&&failed&&layerQueueRecovery,archiveExpiresAt:layerQueueRecovery?new Date(Date.now()+86400000).toISOString():null};}
      layerTaskReads.push({requestId:value.view.requestId,status:value.view.status,method:'GET',direct:url.searchParams.has('requestId')});
      return contracts.StudioDecompositionView.parse(value.view);
    }
    if(url.searchParams.has('requestId')) {const value=decompositions.get(url.searchParams.get('requestId'));return value?json(res,read(value)):json(res,{error:'任务不存在'},404);}
    return json(res,{requests:[...decompositions.values()].map(read)});
  }
  if(url.pathname===`/api/workspaces/${fixture.workspaceId}/notifications`) {
    if(req.headers['x-novart-user']!==fixture.userId||url.searchParams.get('scope')!=='studio') return json(res,{error:'Fixture notification scope mismatch'},403);
    const notifications=[...[...uploads.values()].map(task=>({id:'fixture-notification-'+task.taskId,kind:'STUDIO_UPLOAD',status:task.status,title:'合成上传任务提醒',createdAt:new Date().toISOString(),href:'/canvas?'+new URLSearchParams({workspaceId:fixture.workspaceId,projectId:fixture.projectId,taskId:task.taskId})})),...[...generations.values()].map(task=>({id:'fixture-notification-'+task.requestId,kind:'STUDIO_GENERATION',status:task.status,title:'合成生成失败提醒',createdAt:new Date().toISOString(),href:'/canvas?'+new URLSearchParams({workspaceId:fixture.workspaceId,projectId:fixture.projectId,requestId:task.requestId})}))];
    return json(res,{items:notifications});
  }
  if(url.pathname===material.url) {res.setHeader('Content-Type','image/png');return res.end(png);}
  const experienceAsset=[...experienceAssets.values()].find(value=>value.url===url.pathname);
  if(experienceAsset){res.setHeader('Cache-Control','no-store');if(failedExperienceAssets.has(experienceAsset.assetId))return json(res,{error:'Synthetic image fetch failure for placement recovery test'},503);res.setHeader('Content-Type','image/png');return res.end(fixturePng(experienceAsset.width,experienceAsset.height,()=>[124,92,255,255]));}
  const layerIndex=layerResults.findIndex(value=>value.url===url.pathname);
  if(layerIndex>=0) {const failed=failLayerDownload&&layerIndex===1;layerDownloads.push({order:layerIndex,failed});res.setHeader('Cache-Control','no-store');if(failed)return json(res,{error:'合成图层下载失败，仅验证全组原子插入'},503);res.setHeader('Content-Type','image/png');return res.end(layerPngs[layerIndex]);}
  return json(res,{error:'No fixture for this route'},404);
}
function check(name) {report.checks.push(name);}
async function fixtureSettled(condition) {const deadline=Date.now()+10000;while(!condition()){assert.ok(Date.now()<deadline,'Expected synthetic server state did not settle');await new Promise(resolve=>setTimeout(resolve,25));}}

(async()=>{
  const entry=path.join(directory,'entry.tsx');
  fs.writeFileSync(entry,`import React from '${path.join(repo,'apps/web/node_modules/react').replaceAll('\\','/')}';\nimport {createRoot} from '${path.join(repo,'apps/web/node_modules/react-dom/client').replaceAll('\\','/')}';\nimport {OwnedEditorClient} from '${path.join(repo,'apps/web/src/components/owned-canvas/OwnedEditorClient').replaceAll('\\','/')}';\nconst params=new URLSearchParams(location.search),task=params.get('taskId'),request=params.get('requestId'),layerRequest=params.get('layerRequestId'),writingPage=location.pathname==='/studio-writing';const initialTask=writingPage||[task,request,layerRequest].filter(Boolean).length!==1?undefined:task?{kind:'STUDIO_UPLOAD' as const,id:task}:request?{kind:'STUDIO_GENERATION' as const,id:request}:layerRequest?{kind:'STUDIO_DECOMPOSITION' as const,id:layerRequest}:undefined;const fixtureRoot=createRoot(document.getElementById('root')!);let fixtureUserId='fixture-user';window.changeFixtureUser=(userId:string)=>{fixtureUserId=userId;window.changeFixtureReadOnly(false);};window.changeFixtureReadOnly=(readOnly:boolean)=>fixtureRoot.render(<OwnedEditorClient {...${JSON.stringify(fixture)}} userId={fixtureUserId} readOnly={readOnly} initialTask={initialTask} writingTaskId={writingPage?task||undefined:undefined} initialSurface={writingPage||params.get('surface')==='writing'?'writing':'canvas'} projectName="交互回归"/>);window.changeFixtureReadOnly(false);`);
  await esbuild.build({entryPoints:[entry],outfile:path.join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
  const schemaEntry=path.join(directory,'schema.ts');
  fs.writeFileSync(schemaEntry,`export {WorkbenchDraftView,WorkbenchDraftSaveInput,StudioWorkflowSaveInput,StudioWorkflowView,StudioGenerationInput,StudioGenerationView,StudioImageToolInput,StudioDecompositionInput,StudioDecompositionView,StudioConversationInput,StudioConversationMessage,StudioConversationDraftInput,StudioConversationDraft,StudioConversationPage,StudioWritingState,StudioWritingGenerateInput,StudioWritingSaveInput,StudioWritingTask,StudioWritingAssetReferenceInput,StudioWritingReferenceAccepted} from '${path.join(repo,'packages/contracts/src/index').replaceAll('\\','/')}';\nexport {emptyOwnedDocument} from '${path.join(repo,'apps/web/src/lib/owned-canvas-model').replaceAll('\\','/')}';\nexport {encodeOwnedCanvas} from '${path.join(repo,'apps/web/src/lib/owned-canvas-codec').replaceAll('\\','/')}';\nexport {workflowAssets,workflowIssues,assertWorkflowSelection} from '${path.join(repo,'apps/web/src/lib/studio-workflow-codec').replaceAll('\\','/')}';`);
  await esbuild.build({entryPoints:[schemaEntry],outfile:path.join(directory,'schema.cjs'),bundle:true,platform:'node',format:'cjs',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],logLevel:'silent'});contracts=require(path.join(directory,'schema.cjs'));
  const css=spawnSync(process.execPath,[path.join(repo,'apps/web/node_modules/tailwindcss/lib/cli.js'),'-i',path.join(repo,'packages/ui/src/styles.css'),'-o',path.join(directory,'tokens.css'),'-c',path.join(repo,'apps/web/tailwind.config.ts'),'--content',[path.join(repo,'apps/web/src/components/owned-canvas/*.{ts,tsx}'),path.join(repo,'apps/web/src/components/writing-workbench/*.{ts,tsx}'),path.join(repo,'packages/ui/src/**/*.{ts,tsx}')].join(',')],{cwd:repo,encoding:'utf8',env:{...process.env,TEMP:directory,TMP:directory},timeout:60000});
  assert.equal(css.status,0,'Actual product styles must compile');
  server=http.createServer((req,res)=>handle(req,res).catch(()=>json(res,{error:'Fixture error'},500)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.NOVART_CHROMIUM_EXECUTABLE?{executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE}:{}),args:['--disable-background-networking']});
  const context=await browser.newContext({viewport:{width:1366,height:850},acceptDownloads:true});
  await context.route('**/*',route=>{const u=new URL(route.request().url());if(['http:','https:'].includes(u.protocol)&&u.origin!==origin){report.externalRequests.push(u.hostname);return route.abort();}return route.continue();});
  const page=await context.newPage(); page.on('pageerror',e=>report.errors.push(e.name));
  const canvasTool=async name=>{const control=page.getByRole('button',{name,exact:true});if(!await control.isVisible())await page.getByRole('button',{name:'更多画布工具',exact:true}).click();await control.click();};
  stage='open-owned-editor';await page.goto(origin+'/studio-editor');
  await page.getByTestId('owned-canvas').waitFor();
  const surface=page.getByTestId('owned-canvas');
  if(layerRepairOnly) {
    const doc=contracts.emptyOwnedDocument();doc.items.push({id:'shape:repair-source',kind:'image',x:160,y:100,w:240,h:160,parentId:doc.pageId,rotation:0,opacity:1,url:material.url,assetId:material.assetId,assetSha256:material.assetSha256,imageNumber:1});
    canvas=await contracts.encodeOwnedCanvas(doc);revision++;experienceAssets.set(material.assetId,material);
    decompositions.set('fixture-decomposition',{reads:2,view:contracts.StudioDecompositionView.parse({requestId:'fixture-decomposition',mutationId:crypto.randomUUID(),projectId:fixture.projectId,sourceShapeId:'shape:repair-source',assetId:material.assetId,assetSha256:material.assetSha256,documentRevision:revision,sourceWidth:12,sourceHeight:8,layerCount:2,status:'SUCCEEDED',error:null,createdAt:new Date().toISOString(),expiresAt:'2099-01-01T00:00:00.000Z',archiveExpiresAt:null,canRetryArchive:false,layers:layerResults})});
    await require('./check-owned-layer-repair-interactions.cjs').runOwnedLayerRepairChecks({page,origin,fixture,material,check,fixtureSettled,
      setStage:value=>{stage=value;},state:()=>({canvas,revision,writes,imageToolInputs}),holdNext:()=>{imageToolResponse='hold';},releaseOld:()=>releaseImageTool?.()});
    assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;return;
  }
  if(targetOnly) {
    await require('./check-owned-target-interactions.cjs').runOwnedTargetChecks({page,surface,origin,fixture,check,fixtureSettled,
      setStage:value=>{stage=value;},state:()=>({conversationDraft,conversationWrites,conversationPosts,workflowWrites,workflow,draft,materialReads,writes,shapes:shapes()}),
      delays:values=>{materialDelays=[...values];},seed:async()=>{const doc=contracts.emptyOwnedDocument();for(let i=0;i<3;i++){
        const id='target-'+String.fromCharCode(97+i),bytes=fixturePng(192,128,()=>[124,92,255,255]);
        const image={id,assetId:id,assetSha256:crypto.createHash('sha256').update(bytes).digest('hex'),kind:'image',mimeType:'image/png',fileName:id+'.png',sizeBytes:bytes.length,width:192,height:128,url:`/api/workspaces/${fixture.workspaceId}/assets/${id}/raw`};experienceAssets.set(id,image);
        if(i<2)doc.items.push({id:'shape:'+id,kind:'image',x:100+i*260,y:180,w:192,h:128,rotation:0,opacity:1,url:image.url,assetId:id,assetSha256:image.assetSha256,imageNumber:i+1});
      }canvas=await contracts.encodeOwnedCanvas(doc);revision++;}});
    assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;return;
  }
  if(copywritingOnly) {
    const output=path.join(repo,'.novart-build/writing-workbench-integration');fs.mkdirSync(output,{recursive:true});
    const open=async(document=false)=>{await page.getByRole('tab',{name:'AI 文案',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="writing-workbench"]')?.dataset.ready==='true');if(document)await page.getByRole('button',{name:'当前稿',exact:true}).click();};
    await open();const panel=page.getByTestId('writing-workbench');
    assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await surface.isVisible(),true);const canvasBounds=await surface.boundingBox(),writingBounds=await panel.boundingBox();assert.ok(canvasBounds&&writingBounds&&canvasBounds.x+canvasBounds.width<=writingBounds.x+1);check('writing-opens-beside-visible-canvas');
    await panel.getByRole('textbox',{name:'本轮文案需求',exact:true}).fill('写一组短标题和正文');
    await panel.getByRole('button',{name:'发送需求',exact:true}).click();await panel.getByRole('button',{name:'加入画布',exact:true}).waitFor();
    await page.setViewportSize({width:1366,height:600});const composerBounds=await panel.getByRole('button',{name:'发送需求',exact:true}).boundingBox();assert.ok(composerBounds&&composerBounds.y>=0&&composerBounds.y+composerBounds.height<=600,'History must scroll instead of pushing the composer below the viewport');check('docked-history-keeps-send-action-visible-in-short-viewport');await page.setViewportSize({width:1366,height:850});
    const beforeDirect=JSON.stringify(writingFixture.state.document);await panel.getByRole('button',{name:'加入画布',exact:true}).click();await fixtureSettled(()=>shapes().length===1&&writes>0);
    assert.equal(JSON.stringify(writingFixture.state.document),beforeDirect);assert.equal(await surface.isVisible(),true);assert.equal(await panel.isVisible(),true);assert.equal(copywritingPosts,1);check('suggestion-inserts-directly-without-adopting-draft-or-extra-model-call');
    await panel.getByRole('button',{name:'加入画布',exact:true}).click();await page.waitForTimeout(150);assert.equal(shapes().length,1);check('direct-suggestion-insertion-is-idempotent');
    await panel.getByRole('textbox',{name:'本轮文案需求',exact:true}).fill('尚未发送的后续需求');await panel.getByRole('button',{name:'展开编辑',exact:true}).click();assert.equal(await surface.isVisible(),false);await panel.getByRole('button',{name:'收回侧栏',exact:true}).click();assert.equal(await surface.isVisible(),true);assert.equal(await panel.getByRole('textbox',{name:'本轮文案需求',exact:true}).inputValue(),'尚未发送的后续需求');check('expand-and-dock-preserve-unsent-composer-without-model-call');
    await panel.getByRole('button',{name:'返回画布',exact:true}).click();await page.getByRole('button',{name:'撤销',exact:true}).click();await fixtureSettled(()=>shapes().length===0);await open();await panel.getByRole('button',{name:'设为当前稿',exact:true}).click();
    const sendBounds=await panel.getByRole('button',{name:'当前稿加入画布',exact:true}).boundingBox();assert.ok(sendBounds&&sendBounds.y>=0&&sendBounds.y+sendBounds.height<=850);check('current-draft-insert-is-visible-without-scrolling-to-bottom');
    await page.waitForFunction(()=>document.querySelector('[data-testid="writing-workbench"]')?.dataset.saveState==='saved');
    await panel.getByRole('button',{name:'当前稿加入画布',exact:true}).click();await fixtureSettled(()=>shapes().length===1&&writes>0);
    assert.equal(shapes()[0].props.text.replaceAll('\n',''),'交互测试标题测试夹具正文，仅用于编辑、撤销和刷新恢复检查。');check('writing-current-draft-inserts-native-editable-text');
    await open(true);await panel.getByRole('button',{name:'当前稿加入画布',exact:true}).click();await page.waitForTimeout(350);assert.equal(shapes().length,1);check('same-document-revision-handoff-is-idempotent');
    await page.getByRole('button',{name:'撤销',exact:true}).click();await fixtureSettled(()=>shapes().length===0);check('writing-insertion-can-be-undone');
    await page.getByRole('button',{name:'重做',exact:true}).click();await fixtureSettled(()=>shapes().length===1);check('writing-insertion-can-be-redone');
    await page.reload();await page.getByTestId('owned-canvas-item').waitFor();assert.equal(shapes().length,1);check('writing-text-restores-on-canvas-after-refresh');
    await open();await panel.getByTestId('writing-turn').waitFor();assert.equal(copywritingPosts,1);check('writing-history-restores-without-repeat-post');
    await panel.getByRole('button',{name:'返回画布',exact:true}).click();await page.getByTestId('owned-canvas-item').dblclick();
    const nativeEditor=page.getByRole('textbox',{name:'编辑画布文字',exact:true});await nativeEditor.fill('已编辑的文案');await nativeEditor.press('Escape');await fixtureSettled(()=>shapes()[0]?.props.text==='已编辑的文案');check('inserted-copy-can-still-be-edited-in-canvas');
    await page.getByTestId('owned-canvas-item').click();await open();await panel.getByRole('button',{name:/^资料/}).click();
    await panel.getByRole('dialog',{name:'本轮参考资料'}).getByText('画布所选文字.txt',{exact:true}).waitFor();assert.equal(writingFixture.state.references.some(r=>r.segments.some(s=>s.text==='已编辑的文案')),true);check('selected-native-text-imports-as-reference-without-overwriting-current-draft');
    await panel.getByRole('button',{name:'关闭本轮参考资料'}).click();await page.setViewportSize({width:390,height:844});assert.ok(await panel.isVisible());assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);check('writing-surface-fits-mobile-width');
    await page.screenshot({path:path.join(output,'01-embedded-mobile.png'),fullPage:true});await page.setViewportSize({width:1366,height:850});
    stage='embedded-long-document-scroll';
    await panel.getByRole('button',{name:'展开编辑',exact:true}).click();
    const longDraft=Array.from({length:100},(_,index)=>`第 ${index+1} 段：这是一段用于验证真实嵌入滚动容器的长文。末尾应能编辑和保存，正文长度超过三千字符。`).join('\n\n');
    const writingBody=panel.getByRole('textbox',{name:'当前稿正文',exact:true});await writingBody.fill(longDraft);
    await writingBody.press('Control+End');await writingBody.press('Enter');await writingBody.pressSequentially('尾段追加：编辑完成。');
    await writingBody.press('Control+s');await page.waitForFunction(()=>document.querySelector('[data-testid="writing-workbench"]')?.dataset.saveState==='saved');
    assert.equal(writingFixture.state.document.text,longDraft+'\n尾段追加：编辑完成。');
    const scrollRegion=page.getByTestId('writing-scroll-region');await scrollRegion.evaluate(element=>{element.scrollTop=element.scrollHeight;});
    assert.ok(await scrollRegion.evaluate(element=>element.scrollTop>1000&&element.scrollHeight>element.clientHeight));
    const footer=panel.getByRole('button',{name:'送回画布',exact:true}),footerBounds=await footer.boundingBox(),regionBounds=await scrollRegion.boundingBox();
    assert.ok(footerBounds&&regionBounds&&footerBounds.y>=regionBounds.y&&footerBounds.y+footerBounds.height<=regionBounds.y+regionBounds.height+1,'Long draft footer is reachable inside embedded scroll region');
    await page.screenshot({path:path.join(output,'03-embedded-long-document-bottom.png')});
    const writingReceipt=writingFixture.state.document.id+'-'+writingFixture.state.document.revision,writingPrefix='shape:writing-'+writingReceipt.length+'_'+writingReceipt+'-';
    await footer.click();await fixtureSettled(()=>shapes().filter(shape=>shape.id.startsWith(writingPrefix)).map(shape=>shape.props.text).join('')===longDraft+'\n尾段追加：编辑完成。');
    check('embedded-long-document-tail-edit-ctrl-s-save-and-bottom-canvas-handoff-remain-reachable');
    const longShapeCount=shapes().length;assert.ok(longShapeCount>2);await open(true);await panel.getByRole('button',{name:'当前稿加入画布',exact:true}).click();await page.waitForTimeout(150);assert.equal(shapes().length,longShapeCount);await page.getByRole('button',{name:'撤销',exact:true}).click();await fixtureSettled(()=>shapes().length===1);await page.getByRole('button',{name:'重做',exact:true}).click();await fixtureSettled(()=>shapes().length===longShapeCount);check('long-draft-handoff-is-idempotent-and-entire-chunk-group-undoes-in-one-step');
    // Use a fresh browser composer scope for a new homepage handoff in this fixture project.
    await page.evaluate(()=>{for(const key of Object.keys(localStorage))if(key.startsWith('novart:writing-workbench:'))localStorage.removeItem(key);});
    const initialCopyPosts=copywritingPosts, initialImagePosts=conversationPosts.length;
    await page.goto(origin+'/home-fixture');await page.waitForFunction(()=>homeStart.snapshot().loaded);
    await page.locator('#ns-mode-copywriting').click();await page.locator('#ns-home-brief').fill('为新品写一句品牌口号');
    await page.locator('#hs-file-input').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:png});await page.waitForFunction(()=>homeStart.snapshot().attachmentCount===1);await page.locator('#ns-create').click();
    await page.waitForFunction(()=>homeStart.snapshot().submittedRequestId===null && document.querySelector('iframe')?.contentDocument?.querySelector('[aria-label="本轮文案需求"]')?.value==='为新品写一句品牌口号',undefined,{timeout:45000});
    const homeFrame=page.frames().find(frame=>new URL(frame.url()).pathname==='/studio-editor');assert.ok(homeFrame);
    const homePanel=homeFrame.getByTestId('writing-workbench');assert.ok(await homePanel.isVisible());assert.equal(await homeFrame.getByTestId('owned-canvas').isVisible(),true);
    assert.ok(writingFixture.state.references.some(r=>r.kind==='IMAGE'));assert.equal(copywritingPosts,initialCopyPosts);assert.equal(conversationPosts.length,initialImagePosts);check('homepage-writing-opens-real-iframe-with-reference-without-model-post');
    await homePanel.getByRole('textbox',{name:'本轮文案需求',exact:true}).fill('调整后的品牌口号需求');await homeFrame.waitForTimeout(150);
    await homeFrame.goto(origin+'/studio-editor?surface=writing');await homeFrame.waitForFunction(()=>document.querySelector('[data-testid="writing-workbench"]')?.dataset.ready==='true');
    assert.equal(await homeFrame.getByRole('textbox',{name:'本轮文案需求',exact:true}).inputValue(),'调整后的品牌口号需求');assert.equal(copywritingPosts,initialCopyPosts);assert.equal(conversationPosts.length,initialImagePosts);check('homepage-writing-composer-refresh-restores-without-paying');
    stage='selected-five-images-to-writing';
    await homePanel.getByRole('button',{name:'返回画布',exact:true}).click();
    const multi=contracts.emptyOwnedDocument();
    for(let i=0;i<5;i++){
      const width=160+i, height=90, bytes=fixturePng(width,height,()=>[124,92,255,255]),assetId='writing-multi-'+i;
      const image={id:assetId,assetId,assetSha256:crypto.createHash('sha256').update(bytes).digest('hex'),kind:'image',mimeType:'image/png',fileName:assetId+'.png',sizeBytes:bytes.length,width,height,url:`/api/workspaces/${fixture.workspaceId}/assets/${assetId}/raw`};
      experienceAssets.set(assetId,image);multi.items.push({id:'shape:writing-multi-'+i,kind:'image',x:i*175,y:0,w:width,h:height,rotation:0,opacity:1,url:image.url,assetId,assetSha256:image.assetSha256,imageNumber:i+1});
    }
    canvas=await contracts.encodeOwnedCanvas(multi);revision++;
    await homeFrame.goto(origin+'/studio-editor');await homeFrame.locator('[data-kind="image"]').nth(4).waitFor();
    await homeFrame.getByTestId('owned-canvas').focus();await page.keyboard.press('Control+a');assert.equal(await homeFrame.locator('[data-owned-id][data-selected="true"]').count(),5);
    const previousReferences=writingFixture.state.references.length;
    await homeFrame.getByRole('tab',{name:'AI 文案',exact:true}).click();await fixtureSettled(()=>writingFixture.state.references.length===previousReferences+5);
    await homePanel.getByText('导入资料均已保存，本轮先选前 4 张图片及范围内文档。更多资料可在“资料”里切换选择。每轮最多 12 份。',{exact:true}).waitFor();
    await homePanel.getByRole('button',{name:/^资料/}).click();assert.equal(await homePanel.getByRole('checkbox',{checked:true}).count(),4);await homePanel.getByRole('button',{name:'关闭本轮参考资料'}).click();
    assert.equal(copywritingPosts,initialCopyPosts);assert.equal(conversationPosts.length,initialImagePosts);check('five-selected-canvas-images-all-imported-four-explicitly-selected-with-visible-limit');
    await page.screenshot({path:path.join(output,'02-homepage-writing.png')});
    stage='writing-parent-open-panel';await homePanel.getByRole('button',{name:'当前稿',exact:true}).click();await homePanel.getByRole('textbox',{name:'当前稿正文',exact:true}).fill('外层打开资料前，先保存文案手改。');await page.evaluate(projectId=>document.querySelector('iframe').contentWindow.postMessage({type:'nv-studio',projectId,action:'open-panel',panel:'materials'},location.origin),fixture.projectId);await homeFrame.getByRole('dialog',{name:'品牌素材',exact:true}).waitFor();assert.equal(writingFixture.state.document.text,'外层打开资料前，先保存文案手改。');assert.equal(await homePanel.isVisible(),false);assert.equal(await homeFrame.getByTestId('owned-canvas').isVisible(),true);check('parent-open-panel-confirms-writing-save-before-showing-visible-canvas-panel');
    stage='writing-notification-link';const notified=writingFixture.state.tasks.find(task=>task.operation==='GENERATE');await page.goto(origin+'/studio-writing?taskId='+encodeURIComponent(notified.id));await page.getByTestId('writing-workbench').locator('[data-task-id="'+notified.id+'"]').waitFor();assert.equal(await page.getByTestId('owned-canvas').isVisible(),true);assert.equal(copywritingPosts,initialCopyPosts);check('writing-notification-task-link-stays-in-writing-and-only-reads-original-task');
    assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;return;
  }
  if(brandOnly) {
    const output=path.join(repo,'.novart-build/home-thumbnail-logo-1020');fs.mkdirSync(output,{recursive:true});
    for(const width of [1440,768,390]) {
      await page.setViewportSize({width,height:900});
      const logo=page.locator('header img[alt="DeepFlare · 曜影深蓝"]');
      await page.waitForFunction(()=>{const img=document.querySelector('header picture img');return img?.complete&&img.naturalWidth>0;});
      assert.ok((await logo.getAttribute('src'))?.includes('deepflare-mark.svg'));
      assert.ok((await logo.evaluate(img=>img.currentSrc)).includes(width>=640?'deepflare-logo.svg':'deepflare-mark.svg'));
      const box=await logo.boundingBox();assert.ok(box&&box.width>0&&box.height>0);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.getByRole('tab',{name:'对话改图',exact:true}).click();
      await page.getByRole('tab',{name:'对话改图',exact:true}).click();
      await page.screenshot({path:path.join(output,'local-fixture-editor-brand-'+width+'.png')});
      check('official Chinese-English logo at '+width+' with responsive toolbar interaction');
    }
    assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);report.passed=true;return;
  }
  if(experienceOnly) {
    await require('./check-owned-experience-interactions.cjs').runOwnedExperienceChecks({page,surface,origin,fixture,check,shapes,
      setStage:value=>{stage=value;},state:()=>({canvas,revision,generationPosts}),
      addResult:(id,{width=256,height=128,fail=false,archiveFailed=false,sourceShapeId}={})=>{
        const bytes=fixturePng(width,height,()=>[124,92,255,255]);
        const image={assetId:'experience-'+id,assetSha256:crypto.createHash('sha256').update(bytes).digest('hex'),mimeType:'image/png',width,height,url:`/api/workspaces/${fixture.workspaceId}/assets/experience-${id}/raw`};
        experienceAssets.set(image.assetId,{...image,id:image.assetId,fileName:id+'.png',sizeBytes:bytes.length,kind:'image'});
        if(fail)failedExperienceAssets.add(image.assetId);
        const task=contracts.StudioGenerationView.parse({mode:sourceShapeId?'modify':'generate',...(sourceShapeId?{sourceShapeId}:{}),requestId:'experience-'+id,mutationId:crypto.randomUUID(),projectId:fixture.projectId,generationId:'experience-generation-'+id,status:'SUCCEEDED',progress:null,expiresAt:new Date(Date.now()+60000+generations.size*1000).toISOString(),archiveExpiresAt:null,archiveProcessingExpiresAt:null,displayText:'Synthetic UI regression '+id,resultState:archiveFailed?'FAILED':'READY',results:archiveFailed?[]:[{...image,versionId:'experience-version-'+id}],error:null,archiveError:archiveFailed?'Synthetic archive failure':null,canRetryArchive:archiveFailed});
        generations.set(task.requestId,task);return task;
      },recoverArchivedResult:id=>{const task=generations.get('experience-'+id),material=experienceAssets.get('experience-'+id);generations.set(task.requestId,{...task,resultState:'READY',archiveError:null,canRetryArchive:false,results:[{versionId:'experience-version-'+id,assetId:material.assetId,assetSha256:material.assetSha256,mimeType:material.mimeType,width:material.width,height:material.height,url:material.url}]});},allowResult:id=>failedExperienceAssets.delete('experience-'+id),materialForHandoff:()=>[...experienceAssets.values()][0]});
    if(process.env.NOVART_OWNED_SCREENSHOT){await page.setViewportSize({width:1366,height:850});await page.screenshot({path:process.env.NOVART_OWNED_SCREENSHOT});}
    assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;return;
  }
  if(layersOnly) {
    await require('./check-owned-layer-interactions.cjs').runOwnedLayerChecks({page,surface,origin,fixture,png,material,layerResults,shapes,records,check,report,
      setStage:value=>{stage=value;},allowLayerDownloads:()=>{failLayerDownload=false;},failureOnly:layerFailureOnly,queueRecovery:layerQueueRecovery,
      state:()=>({canvas,revision,writes,decompositionPosts,decompositionPostInputs,layerTaskReads,layerDownloads,layerRecoveryPosts,layerReadFailures})});
    assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;return;
  }
  if(process.env.NOVART_OWNED_TOOLS_ONLY==='1') {
    stage='upload-tools-only-fixture';await page.locator('input[type=file]').first().setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:png});
    await page.locator('[data-testid="owned-canvas-item"][data-kind="image"]').waitFor();
    await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]')?.dataset.saveState==='saved');
    stage='complete-owned-editing-tools';
    try {await require('./check-owned-tools-interactions.cjs').runOwnedToolChecks({page,surface,check,records,shapes,png,
      waitSaved:async()=>{await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]')?.dataset.saveState==='saved');}});}
    catch(error){report.toolsFailureState=await page.evaluate(()=>({status:document.querySelector('.oc-status')?.textContent,
      itemCount:document.querySelectorAll('[data-testid="owned-canvas-item"]').length,saveState:document.querySelector('[data-testid="owned-editor"]')?.dataset.saveState}));throw error;}
    assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;return;
  }
  const bounds=await surface.boundingBox();assert.ok(bounds&&bounds.width>400&&bounds.height>300);
  const draw=async(label,x,y,w,h)=>{await canvasTool(label);await page.mouse.move(bounds.x+x,bounds.y+y);await page.mouse.down();await page.mouse.move(bounds.x+x+w,bounds.y+y+h,{steps:8});await page.mouse.up();};
  stage='draw-and-history';await draw('图形',160,130,150,110);await page.getByTestId('owned-canvas-item').waitFor();check('draw-rectangle');
  await page.getByRole('button',{name:'撤销',exact:true}).click();await assert.equal(await page.getByTestId('owned-canvas-item').count(),0);await page.getByRole('button',{name:'重做',exact:true}).click();assert.equal(await page.getByTestId('owned-canvas-item').count(),1);check('undo-redo');
  await draw('画笔',360,210,110,75);assert.equal(await page.getByTestId('owned-canvas-item').count(),2);check('freehand-stroke');
  stage='text-edit';await page.getByRole('button',{name:'文字',exact:true}).click();await page.mouse.click(bounds.x+160,bounds.y+330);const text=page.getByRole('textbox',{name:'编辑画布文字',exact:true});await text.waitFor();await text.fill('中文画布\n第二行');await text.press('Control+Enter');check('chinese-multiline-text');
  stage='persistent-upload';await page.locator('input[type=file]').first().setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:png});await page.locator('[data-testid="owned-canvas-item"][data-kind="image"]').waitFor();check('upload-and-insert');
  await page.getByRole('button',{name:'撤销',exact:true}).click();assert.equal(await page.locator('[data-kind="image"][data-owned-id]').count(),0);await page.getByRole('button',{name:'重做',exact:true}).click();assert.equal(await page.locator('[data-kind="image"][data-owned-id]').count(),1);check('uploaded-image-undo-redo');
  stage='save-and-reopen';const saveButton=page.getByRole('button',{name:'保存',exact:true});if(await saveButton.isEnabled())await saveButton.click();await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]').dataset.saveState==='saved');assert.equal(shapes().length,4);let before=canvas;
  await page.reload();await page.getByTestId('owned-canvas-item').nth(3).waitFor();assert.equal(canvas,before);check('mixed-document-save-reopen');
  stage='object-transforms';await page.getByRole('button',{name:'适合画布',exact:true}).click();await page.getByRole('button',{name:'移动画布',exact:true}).click();await page.mouse.move(bounds.x+600,bounds.y+300);await page.mouse.down();await page.mouse.move(bounds.x+600,bounds.y+400,{steps:5});await page.mouse.up();await page.getByRole('button',{name:'选择',exact:true}).click();const rectangle=page.locator('[data-kind="shape"][data-owned-id]').first();await rectangle.click();
  const resize=page.getByRole('button',{name:'调整右下尺寸',exact:true});const corner=await resize.boundingBox();assert.ok(corner);const oldSize=await rectangle.boundingBox();await page.mouse.move(corner.x+corner.width/2,corner.y+corner.height/2);await page.mouse.down();await page.mouse.move(corner.x+55,corner.y+40,{steps:8});await page.mouse.up();const changedSize=await rectangle.boundingBox();assert.ok(changedSize.width>oldSize.width+20);check('pointer-resize');
  const rotation=page.getByRole('button',{name:'旋转选中元素',exact:true}),rotationBox=await rotation.boundingBox();const rotationStart=await rectangle.getAttribute('style');await page.mouse.move(rotationBox.x+rotationBox.width/2,rotationBox.y+rotationBox.height/2);await page.mouse.down();await page.mouse.move(rotationBox.x+120,rotationBox.y+100,{steps:8});await page.mouse.up();assert.notEqual(await rectangle.getAttribute('style'),rotationStart);check('pointer-rotate');
  await surface.focus();await page.keyboard.press('Control+a');assert.equal(await page.locator('[data-owned-id][data-selected="true"]').count(),4);await page.keyboard.press('ArrowRight');await page.keyboard.press('Delete');assert.equal(await page.getByTestId('owned-canvas-item').count(),0);await page.getByRole('button',{name:'撤销',exact:true}).click();assert.equal(await page.getByTestId('owned-canvas-item').count(),4);check('multiselect-nudge-delete-undo');
  await page.getByRole('button',{name:'恢复100%缩放',exact:true}).click();await page.getByRole('button',{name:'放大',exact:true}).click();assert.match(await page.getByRole('button',{name:'恢复100%缩放'}).textContent(),/120%/);await page.getByRole('button',{name:'移动画布',exact:true}).click();const worldStyle=await page.locator('.oc-world').getAttribute('style');await page.mouse.move(bounds.x+600,bounds.y+450);await page.mouse.down();await page.mouse.move(bounds.x+650,bounds.y+480,{steps:8});await page.mouse.up();assert.notEqual(await page.locator('.oc-world').getAttribute('style'),worldStyle);check('pan-zoom');
  await page.getByRole('button',{name:'选择',exact:true}).click();if(await saveButton.isEnabled())await saveButton.click();await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]').dataset.saveState==='saved');before=canvas;
  stage='export';for(const label of ['导出SVG','导出PNG']) {await canvasTool('导出');const event=page.waitForEvent('download');await page.getByRole('button',{name:label,exact:true}).click();const download=await event;const file=await download.path();const bytes=fs.readFileSync(file);assert.ok(bytes.length>50);if(label==='导出PNG') assert.equal(bytes.subarray(1,4).toString(),'PNG');else assert.match(bytes.toString(),/<svg/);check(label);}
  const openAdvanced=async(scope=page)=>{if(await scope.getByRole('dialog',{name:'素材与画框',exact:true}).isVisible())return;const settings=scope.getByTestId('conversation-settings');if(await settings.getAttribute('open')===null)await scope.getByLabel('生成设置',{exact:true}).click();await scope.getByRole('button',{name:'素材用途与输出画框',exact:true}).click();};
  const closeAdvanced=async(scope=page)=>{const close=scope.getByRole('button',{name:'关闭工具窗口',exact:true});if(await close.isVisible())await close.click();};
  const openComposerSettings=async()=>{const settings=page.getByTestId('conversation-settings');if(await settings.getAttribute('open')===null)await page.getByLabel('生成设置',{exact:true}).click();};
  const waitDraft=async(expectedText)=>{await page.waitForFunction(()=>document.querySelector('[data-testid="owned-conversation"]')?.dataset.conversationReady==='true');if(expectedText!==undefined)await fixtureSettled(()=>conversationDraft?.text===expectedText);await page.waitForFunction(()=>document.querySelector('[data-testid="conversation-draft-status"]')?.dataset.saved==='true');};
  const waitWorkflow=async()=>{await openAdvanced();return page.waitForFunction(()=>{const el=document.querySelector('[data-testid="owned-workflow"]');return el?.dataset.workflowState==='ready'&&el.dataset.workflowDirty==='false';});};
  const saveWorkflow=async()=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/workflow'&&r.request().method()==='POST');await page.getByRole('button',{name:'完成并应用到对话',exact:true}).click();assert.equal((await response).status(),200);await page.getByRole('dialog',{name:'素材与画框',exact:true}).waitFor({state:'hidden'});await waitDraft();};
  stage='draft-save-and-refresh';await waitDraft();
  await page.getByRole('textbox',{name:'对话设计需求',exact:true}).fill('合成需求：保留中文\n刷新后继续编辑');await openComposerSettings();
  await page.getByRole('combobox',{name:'对话图片比例',exact:true}).selectOption('16:9');await page.getByRole('combobox',{name:'对话图片画质',exact:true}).selectOption('2K');
  await waitDraft('合成需求：保留中文\n刷新后继续编辑');assert.deepEqual(conversationDraft.sizeSelection,{ratioKey:'16:9',resolutionTier:'2K'});
  const savedDraftRevision=conversationDraft.revision;await page.reload();await waitDraft();await openComposerSettings();
  assert.equal(await page.getByRole('textbox',{name:'对话设计需求',exact:true}).inputValue(),conversationDraft.text);assert.equal(await page.getByRole('combobox',{name:'对话图片比例',exact:true}).inputValue(),'16:9');assert.equal(await page.getByRole('combobox',{name:'对话图片画质',exact:true}).inputValue(),'2K');assert.equal(conversationDraft.revision,savedDraftRevision);check('draft-text-size-restored-without-empty-overwrite');
  stage='draft-ime';const prompt=page.getByRole('textbox',{name:'对话设计需求',exact:true}),beforeIme=conversationDraft.revision;
  await prompt.dispatchEvent('compositionstart',{data:''});await prompt.fill('zhongwenshuru');await page.waitForTimeout(900);assert.equal(conversationDraft.revision,beforeIme,'IME partial input must not be persisted');
  await prompt.fill('合成测试需求：中文输入完成');await prompt.dispatchEvent('compositionend',{data:'中文输入完成'});await waitDraft('合成测试需求：中文输入完成');check('ime-commits-before-draft-save');
  stage='workflow-target-reference';await waitWorkflow();
  const imageAsset=currentWorkflowAssets().assets[0];assert.ok(imageAsset?.valid,'Candidate is backed by saved canvas and persistent fixture material');const assetKey=JSON.stringify([imageAsset.shapeId,imageAsset.assetSha256]);
  assert.equal(await page.getByRole('combobox',{name:'创作方式',exact:true}).count(),0);assert.equal(await page.getByRole('combobox',{name:'修改目标',exact:true}).count(),0);
  await page.getByRole('combobox',{name:'添加画布素材用途',exact:true}).selectOption(assetKey);await page.getByRole('button',{name:'添加用途',exact:true}).click();
  assert.equal(await page.getByRole('checkbox',{name:'参与生成 1',exact:true}).isChecked(),true,'Explicitly adding a reference selects it for the next confirmed request');assert.equal(generationPosts,0,'Adding reference never submits a paid task');
  await page.getByRole('combobox',{name:'素材用途 1',exact:true}).selectOption('ADAPTIVE');await page.getByRole('checkbox',{name:'参与生成 1',exact:true}).check();await saveWorkflow();
  assert.equal(workflow.references[0].purpose,'ADAPTIVE');assert.equal(workflow.references[0].participates,true);assert.ok(workflowWrites>0);
  await page.getByRole('dialog',{name:'素材与画框',exact:true}).waitFor({state:'hidden'});await page.getByRole('button',{name:'图层',exact:true}).click();await page.getByRole('button',{name:'选择图层 图片1',exact:true}).click();await page.getByRole('button',{name:'图层',exact:true}).click();await fixtureSettled(()=>conversationDraft.quickEditTargetId===imageAsset.shapeId);await waitDraft();
  assert.equal(conversationDraft.quickEditTargetId,imageAsset.shapeId);assert.equal(conversationDraft.references[0].purpose,'ADAPTIVE');
  const savedWorkflowRevision=workflow.revision;await page.reload();await waitDraft();assert.equal(await page.getByTestId('conversation-target').getByText('图片1',{exact:true}).count(),1);assert.equal(conversationDraft.quickEditTargetId,imageAsset.shapeId);await waitWorkflow();
  assert.equal(await page.getByRole('combobox',{name:'素材用途 1',exact:true}).inputValue(),'ADAPTIVE');assert.equal(await page.getByRole('checkbox',{name:'参与生成 1',exact:true}).isChecked(),true);assert.equal(workflow.revision,savedWorkflowRevision);check('composer-target-purpose-participation-reopen-without-duplicate-mode-controls');
  stage='exact-output-frame-draft';await closeAdvanced();await page.getByRole('button',{name:'取消修改对象',exact:true}).click();await fixtureSettled(()=>conversationDraft.quickEditTargetId===null);await waitDraft();await waitWorkflow();await page.getByRole('combobox',{name:'素材用途 1',exact:true}).selectOption('EXACT');
  await page.getByRole('button',{name:'按输出比例新建画框',exact:true}).click();const frameId=await page.getByRole('combobox',{name:'输出画框',exact:true}).inputValue();assert.match(frameId,/^shape:/);
  await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]').dataset.saveState==='saved');await fixtureSettled(()=>draft.inputForm?.outputFrameId===frameId);await saveWorkflow();assert.equal(workflow.target,null);assert.equal(generationPosts,0);
  await page.getByRole('dialog',{name:'素材与画框',exact:true}).waitFor({state:'hidden'});await waitDraft();assert.equal(conversationDraft.references[0].purpose,'EXACT');
  stage='removed-workflow-reference-clears-composer';await waitWorkflow();await page.getByRole('button',{name:'移除素材用途 1',exact:true}).click();await saveWorkflow();await page.getByRole('dialog',{name:'素材与画框',exact:true}).waitFor({state:'hidden'});await waitDraft();assert.equal(conversationDraft.references.length,0);check('removed-strict-workflow-reference-is-also-removed-from-composer');
  await waitWorkflow();await page.getByRole('combobox',{name:'添加画布素材用途',exact:true}).selectOption(assetKey);await page.getByRole('button',{name:'添加用途',exact:true}).click();await page.getByRole('combobox',{name:'素材用途 1',exact:true}).selectOption('EXACT');await page.getByRole('checkbox',{name:'参与生成 1',exact:true}).check();await saveWorkflow();await page.getByRole('dialog',{name:'素材与画框',exact:true}).waitFor({state:'hidden'});await waitDraft();assert.equal(conversationDraft.references.length,1);
  before=canvas;const baselineShapes=shapes().length;assert.equal(baselineShapes,5);await page.reload();await waitDraft();await waitWorkflow();assert.equal(await page.getByRole('combobox',{name:'输出画框',exact:true}).inputValue(),frameId);assert.equal(await page.getByRole('combobox',{name:'素材用途 1',exact:true}).inputValue(),'EXACT');assert.equal(canvas,before);check('exact-output-frame-restores-with-document-and-draft');
  stage='missing-provider';await closeAdvanced();await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByRole('alert').filter({hasText:'真实模型未配置，不接受fixture生成'}).waitFor();assert.equal(await prompt.inputValue(),'合成测试需求：中文输入完成');assert.equal(conversationPosts.length,1);assert.equal(generations.size,0);check('missing-provider-preserves-prompt-and-does-not-invent-task');
  stage='lost-conversation-receipt-reload';const conversationPendingKey='deepflare:conversation-pending:'+JSON.stringify([fixture.userId,fixture.workspaceId,fixture.projectId]);
  const conversationRecord=await page.evaluate(key=>localStorage.getItem(key),conversationPendingKey);assert.ok(conversationRecord);assert.deepEqual(JSON.parse(conversationRecord),conversationPosts[0]);const uncertainPosts=conversationPosts.length;
  await page.reload();await waitDraft();assert.equal(await prompt.isDisabled(),true);assert.equal(conversationPosts.length,uncertainPosts);assert.equal(await page.evaluate(key=>localStorage.getItem(key),conversationPendingKey),conversationRecord);check('uncertain-conversation-reloads-frozen-without-auto-post');
  await page.getByRole('button',{name:'检查上次提交',exact:true}).click();await fixtureSettled(()=>conversationPosts.length===uncertainPosts+1);assert.deepEqual(conversationPosts[1],conversationPosts[0]);assert.equal(generations.size,0);check('explicit-conversation-confirmation-replays-exact-mutation-and-payload');
  // Seed a real-format legacy journal to exercise recovery after the duplicate
  // composer is removed. Only fixtures manipulate storage; product cannot erase it.
  const pendingKey='novart-owned-generation-pending-v1:'+ [fixture.workspaceId,fixture.userId,fixture.projectId].map(encodeURIComponent).join(':');
  const legacyInput={projectId:fixture.projectId,mutationId:crypto.randomUUID(),prompt:conversationDraft.text,sizeSelection:conversationDraft.sizeSelection,workflowRevision:workflow.revision,documentRevision:revision,outputFrameId:frameId};
  const pendingRecord=JSON.stringify({...fixture,version:1,intent:{mode:'generate',input:legacyInput}});
  await page.evaluate(({newKey,oldKey,record})=>{localStorage.removeItem(newKey);sessionStorage.setItem(oldKey,record);},{newKey:conversationPendingKey,oldKey:pendingKey,record:pendingRecord});
  const pendingBaseline={posts:generationPosts,draftWrites,workflowWrites,canvas};await page.reload();await waitDraft();assert.equal(await prompt.isDisabled(),true);await page.getByRole('tab',{name:'任务记录',exact:true}).click();
  const confirmIntent=page.getByRole('button',{name:'检查上次生成',exact:true});await confirmIntent.waitFor();assert.equal(await confirmIntent.isEnabled(),true);assert.equal(generationPosts,pendingBaseline.posts);assert.equal(draftWrites,pendingBaseline.draftWrites);assert.equal(workflowWrites,pendingBaseline.workflowWrites);assert.equal(canvas,pendingBaseline.canvas);check('legacy-uncertain-generation-locks-new-composer-without-auto-post');
  const confirmedResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/studio/generation'&&response.request().method()==='POST');await confirmIntent.click();assert.equal((await confirmedResponse).status(),503);assert.deepEqual(generationPostInputs[0],legacyInput);assert.equal(generations.size,0);assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),pendingKey),pendingRecord);check('legacy-confirmation-replays-exact-mutation-and-payload-from-task-modal');
  for(const scenario of ['corrupt','unavailable','quota','readonly']) {
    stage='generation-journal-'+scenario;const isolatedContext=await browser.newContext({viewport:{width:1366,height:850}});
    try {
      await isolatedContext.route('**/*',route=>{const u=new URL(route.request().url());if(['http:','https:'].includes(u.protocol)&&u.origin!==origin){report.externalRequests.push(u.hostname);return route.abort();}return route.continue();});
      await isolatedContext.addInitScript(({scenario,key,record,newKey})=>{if(scenario==='corrupt')sessionStorage.setItem(key,'{unreadable');if(scenario==='readonly')sessionStorage.setItem(key,record);if(scenario==='unavailable')Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('Unavailable','SecurityError');}});if(scenario==='quota'){const original=Storage.prototype.setItem;Storage.prototype.setItem=function(name,value){if(this===window.localStorage&&name===newKey)throw new DOMException('Unavailable','QuotaExceededError');return original.call(this,name,value);};}},{scenario,key:pendingKey,record:pendingRecord,newKey:conversationPendingKey});
      const isolatedPage=await isolatedContext.newPage();isolatedPage.on('pageerror',error=>report.errors.push(error.name));const noPost=generationPosts,noConversation=conversationPosts.length;await isolatedPage.goto(origin+'/studio-editor');await isolatedPage.getByTestId('owned-canvas').waitFor();await isolatedPage.waitForFunction(()=>document.querySelector('[data-testid="owned-conversation"]')?.dataset.conversationReady==='true');
      if(scenario==='quota'){await isolatedPage.getByRole('button',{name:'发送',exact:true}).click();await isolatedPage.getByRole('alert').waitFor();assert.equal(await isolatedPage.evaluate(key=>localStorage.getItem(key),conversationPendingKey),null);}
      else if(scenario==='readonly'){await isolatedPage.evaluate(()=>window.changeFixtureReadOnly(true));await isolatedPage.getByRole('tab',{name:'任务记录',exact:true}).click();assert.equal(await isolatedPage.getByRole('button',{name:'检查上次生成',exact:true}).isDisabled(),true);assert.equal(await isolatedPage.evaluate(key=>sessionStorage.getItem(key),pendingKey),pendingRecord);await isolatedPage.getByRole('tab',{name:'对话改图',exact:true}).click();}
      else{await isolatedPage.getByRole('status').filter({hasText:scenario==='corrupt'?'上一份创作的确认记录暂不可读':'浏览器暂不能保存创作确认记录'}).waitFor();if(scenario==='corrupt')assert.equal(await isolatedPage.evaluate(key=>sessionStorage.getItem(key),pendingKey),'{unreadable');}
      if(scenario!=='quota')assert.equal(await isolatedPage.getByRole('textbox',{name:'对话设计需求',exact:true}).isDisabled(),true);
      assert.equal(generationPosts,noPost);assert.equal(conversationPosts.length,noConversation,'Unsafe journals never submit a paid request');assert.equal(generations.size,0);check('generation-journal-'+scenario+'-preserves-safety-without-post');
    } finally {await isolatedContext.close();}
  }
  await closeAdvanced();
  if(process.env.NOVART_OWNED_SCREENSHOT)await page.screenshot({path:process.env.NOVART_OWNED_SCREENSHOT});
  stage='stable-no-sdk';await page.evaluate(()=>{const element=document.querySelector('[data-testid="owned-canvas"]');window.ownedStability={element,started:performance.now(),removed:false};window.ownedObserver=new MutationObserver(records=>{if(!element.isConnected||records.some(record=>[...record.removedNodes].some(node=>node===element||node instanceof Element&&node.contains(element))))window.ownedStability.removed=true;});window.ownedObserver.observe(document.body,{childList:true,subtree:true});});
  await page.waitForTimeout(15100);const stability=await page.evaluate(()=>{window.ownedObserver.disconnect();return {elapsed:performance.now()-window.ownedStability.started,removed:window.ownedStability.removed,same:window.ownedStability.element===document.querySelector('[data-testid="owned-canvas"]')};});assert.ok(stability.elapsed>=15000);assert.equal(stability.removed,false);assert.equal(stability.same,true);await page.getByRole('button',{name:'更多画布工具',exact:true}).click();assert.equal(await page.getByRole('button',{name:'画笔',exact:true}).isVisible(),true);await page.getByRole('button',{name:'更多画布工具',exact:true}).click();assert.equal(await surface.count(),1);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);assert.equal(await page.evaluate(()=>!!window.webpackChunk_lovartai_lovart_shell),false);check('canvas-and-toolbar-stable-15-seconds-without-sdk');
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
  const requestId=crypto.randomUUID();await page.evaluate(({requestId,projectId,material})=>document.querySelector('iframe').contentWindow.postMessage({type:'nv-studio',action:'insert-material',projectId,requestId,material},location.origin),{requestId,projectId:fixture.projectId,material});await page.waitForFunction(id=>receipts.some(r=>r.action==='insert-material-result'&&r.requestId===id),requestId);assert.equal(await page.evaluate(id=>receipts.find(r=>r.action==='insert-material-result'&&r.requestId===id),requestId).then(r=>r.status+':'+(r.error||'')),'saved:');assert.equal(shapes().length,baselineShapes+1);const handoff=canvas;
  await page.evaluate(({requestId,projectId,material})=>document.querySelector('iframe').contentWindow.postMessage({type:'nv-studio',action:'insert-material',projectId,requestId,material},location.origin),{requestId,projectId:fixture.projectId,material});await page.waitForFunction(id=>receipts.filter(r=>r.action==='insert-material-result'&&r.requestId===id&&r.status==='saved').length===2,requestId);assert.equal(canvas,handoff);check('parent-material-handoff-saved-idempotently');before=canvas;
  const confirmation=crypto.randomUUID();await page.evaluate(({requestId,projectId})=>document.querySelector('iframe').contentWindow.postMessage({type:'nv-studio',action:'confirm-save',projectId,requestId},location.origin),{requestId:confirmation,projectId:fixture.projectId});await page.waitForFunction(id=>receipts.some(r=>r.action==='confirm-save-result'&&r.requestId===id&&r.status==='saved'),confirmation);check('parent-confirms-save');
  stage='brand-leave-real-editor';
  const leaveContext=await browser.newContext({viewport:{width:1366,height:850}});
  try {
    await leaveContext.route('**/*',route=>{const u=new URL(route.request().url());if(['http:','https:'].includes(u.protocol)&&u.origin!==origin){report.externalRequests.push(u.hostname);return route.abort();}return route.continue();});
    const leavePage=await leaveContext.newPage();leavePage.on('pageerror',error=>report.errors.push(error.name));await leavePage.goto(origin+'/shell');
    await leavePage.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('[data-testid="owned-conversation"]')?.dataset.conversationReady==='true');
    const editor=leavePage.frameLocator('iframe'), leavePrompt=editor.getByRole('textbox',{name:'对话设计需求',exact:true});
    async function requestLeave() {
      const requestId=crypto.randomUUID();await leavePage.evaluate(({requestId,projectId})=>document.querySelector('iframe').contentWindow.postMessage({type:'nv-studio',action:'confirm-leave',projectId,requestId},location.origin),{requestId,projectId:fixture.projectId});
      await leavePage.waitForFunction(id=>receipts.some(r=>r.action==='confirm-leave-result'&&r.requestId===id),requestId);
      return leavePage.evaluate(id=>receipts.find(r=>r.action==='confirm-leave-result'&&r.requestId===id),requestId);
    }
    const imeWrites=draftWrites;await leavePrompt.dispatchEvent('compositionstart',{data:''});await leavePrompt.fill('pinpaishuru');
    const rejectedIme=await requestLeave();assert.equal(rejectedIme.status,'failed');assert.match(rejectedIme.error,/中文输入/);assert.equal(draftWrites,imeWrites);assert.equal(await leavePrompt.inputValue(),'pinpaishuru');check('brand-leave-refuses-unfinished-ime-and-keeps-current-composer');
    await leavePrompt.fill('切换品牌前保留的完整中文需求');await leavePrompt.dispatchEvent('compositionend',{data:'完整中文需求'});
    await openAdvanced(editor);await editor.getByRole('combobox',{name:'素材用途 1',exact:true}).selectOption('REFERENCE');
    const savedLeave=await requestLeave();assert.equal(savedLeave.status,'saved');assert.equal(conversationDraft.text,'切换品牌前保留的完整中文需求');assert.equal(workflow.references[0].purpose,'REFERENCE');assert.equal(shapes().length,baselineShapes+1);check('brand-leave-confirms-composer-workflow-and-canvas-before-ack');
    await closeAdvanced(editor);const item=editor.locator('[data-testid="owned-canvas-item"][data-kind="image"]').last();const box=await item.boundingBox();assert.ok(box);
    await editor.getByRole('button',{name:'选择',exact:true}).click();delayDocument=1600;await leavePage.mouse.move(box.x+box.width/2,box.y+box.height/2);await leavePage.mouse.down();await leavePage.mouse.move(box.x+box.width/2+35,box.y+box.height/2+25,{steps:5});await leavePage.mouse.up();
    await leavePage.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('[data-testid="owned-editor"]')?.dataset.saveState==='saving');
    const leaveStarted=Date.now(),settledSaving=await requestLeave();assert.equal(settledSaving.status,'saved');assert.ok(Date.now()-leaveStarted>=900,'Leave receipt must wait for the synthetic 1600ms save response');
    await leavePage.waitForFunction(()=>document.querySelector('iframe')?.contentDocument?.querySelector('[data-testid="owned-editor"]')?.dataset.saveState==='saved');delayDocument=0;
    assert.equal((await requestLeave()).status,'saved');assert.equal(shapes().length,baselineShapes+1);check('brand-leave-waits-for-in-flight-document-save-before-confirmed-ack');
    before=canvas;
  } finally {delayDocument=0;await leaveContext.close();}
  stage='handoff-turns-readonly';delayMaterials=350;const readonlyRequest=crypto.randomUUID();await page.evaluate(({requestId,projectId,material})=>{const frame=document.querySelector('iframe').contentWindow;frame.postMessage({type:'nv-studio',action:'insert-material',projectId,requestId,material},location.origin);setTimeout(()=>frame.changeFixtureReadOnly(true),100);},{requestId:readonlyRequest,projectId:fixture.projectId,material});await page.waitForFunction(id=>receipts.some(r=>r.action==='insert-material-result'&&r.requestId===id&&r.status==='failed'),readonlyRequest);assert.equal(canvas,before);assert.equal(shapes().length,baselineShapes+1);check('readonly-during-handoff-never-confirms-insertion');delayMaterials=0;
  stage='conflict';conflict=true;await page.goto(origin+'/studio-editor');await surface.waitFor();await draw('图形',180,140,120,80);await page.getByText('保存冲突',{exact:true}).waitFor();assert.equal(canvas,before);await page.getByRole('button',{name:'更多画布工具',exact:true}).click();assert.equal(await page.getByRole('button',{name:'画笔',exact:true}).isDisabled(),true);check('save-conflict-preserves-server-and-local-content');conflict=false;
  stage='restore-failure';failRestore=true;const initialWrites=writes;await page.goto(origin+'/studio-editor');await page.getByText('合成恢复失败',{exact:false}).waitFor();await page.waitForTimeout(1500);assert.equal(writes,initialWrites);assert.equal(canvas,before);check('failed-restore-never-writes-empty');failRestore=false;
  stage='homepage-file-to-saved-owned-editor';await page.evaluate(key=>sessionStorage.removeItem(key),pendingKey);conversationDraft=null;delayConversation=1200;delayWorkflow=900;canvas='';revision=0;uploads.clear();generations.clear();draft={projectId:fixture.projectId,revision:0,inputForm:null,updatedAt:null,referenceIssues:[]};workflow={projectId:fixture.projectId,revision:0,mode:'generate',target:null,references:[],updatedAt:null,issues:[]};await page.goto(origin+'/home-fixture');await page.waitForFunction(()=>homeStart.snapshot().loaded);await page.locator('#ns-home-brief').fill('首页带图测试');await page.locator('#hs-file-input').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:png});await page.waitForFunction(()=>homeStart.snapshot().attachmentCount===1);await page.locator('#ns-create').click();await page.waitForFunction(()=>homeStart.snapshot().submittedRequestId===null&&homeStart.snapshot().attachmentCount===0&&document.querySelector('iframe').contentDocument?.querySelector('[data-kind="image"]'),undefined,{timeout:45000});assert.equal(shapes().length,1);assert.ok(revision>=1);const homeSaved=canvas;const homeFrame=page.frames().find(frame=>new URL(frame.url()).pathname==='/studio-editor');assert.ok(homeFrame);await homeFrame.goto(origin+'/studio-editor');await homeFrame.getByTestId('owned-canvas-item').waitFor();assert.equal(canvas,homeSaved);assert.equal(conversationPosts.filter(input=>input.homeStart).length,1);delayConversation=0;delayWorkflow=0;check('homepage-file-handoff-waits-for-delayed-restore-and-clears-only-after-saved-and-accepted');
  stage='complete-owned-editing-tools';await page.goto(origin+'/studio-editor');await page.getByTestId('owned-canvas').waitFor();
  await require('./check-owned-tools-interactions.cjs').runOwnedToolChecks({page,surface:page.getByTestId('owned-canvas'),check,records,shapes,png,
    waitSaved:async()=>{await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]')?.dataset.saveState==='saved');}});
  assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;
})().catch(error=>{report.passed=false;report.fatal={stage,name:error.name,message:String(error.message).slice(0,500),stack:String(error.stack).slice(0,1600)};process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
  const reportPath=process.env.NOVART_OWNED_REPORT;if(reportPath)fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  assert.equal(path.dirname(directory),temporaryRoot);fs.rmSync(directory,{recursive:true,force:true});
});

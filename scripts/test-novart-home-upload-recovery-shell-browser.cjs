/* Actual Studio shell + bootstrap + CSS, clicked in a fresh loopback Chromium.
 * Membership, cookies, data and editor ACKs below are synthetic HTTP/protocol
 * fixtures. This verifies interaction boundaries, not real DB/auth acceptance. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright-core');
const repo = path.resolve(__dirname,'..'), exported=path.join(repo,'.novart-build/studio');
const reportPath=process.env.NOVART_UPLOAD_RECOVERY_SHELL_REPORT || path.join(repo,'.novart-build/reports/upload-recovery-shell-'+Date.now()+'.json');
const temporaryRoot=path.join(repo,'.novart-build/temporary');fs.mkdirSync(temporaryRoot,{recursive:true});
const directory=fs.mkdtempSync(path.join(temporaryRoot,'upload-recovery-shell-')), priorTemp={TEMP:process.env.TEMP,TMP:process.env.TMP};
process.env.TEMP=directory;process.env.TMP=directory;fs.mkdirSync(path.dirname(reportPath),{recursive:true});
const report={isolated:true,realBackend:false,realProvider:false,realAuthentication:false,realOwnedEditor:false,providerCalls:0,
  scope:'Production Studio/bootstrap/CSS with synthetic membership/persistence and iframe ACKs; actual OwnedEditor leave/save is tested in the owned-canvas browser suite',checks:[],errors:[],externalRequests:[],passed:false};
const actor={id:'brand-switch-actor',name:'交互检查',email:''};
const brands=[{id:'brand-switch-one',name:'山海生活',ownerId:actor.id,role:'OWNER'}], stores=new Map();
const projects=new Map([['existing-project',{projectId:'existing-project',projectName:'已有项目',hasCanvas:true,updatedAt:'2026-10-19T08:00:00Z',archiveRevision:0,archivedAt:null}]]),creationReceipts=new Map(),uploads=new Map(),accepted=new Map();
const writes=[], leaveRequests=[];let server,browser,page,stage='fixture',failCreate=false,failSelection=false,failState=false,leaveRejected=false,legacyFactory=false;
function store(id) {if(!stores.has(id))stores.set(id,{revision:0,profile:{nickname:'交互检查',density:'comfortable',motion:'reduce'},brand:{name:brands.find(b=>b.id===id)?.name||'',colors:['#7C5CFF','#202028','#F6F4FC'],font:'sans',notes:''},favorites:[]});return stores.get(id);}
const cookieBrand=req=>(req.headers.cookie||'').match(/(?:^|;\s*)brandai-active-brand=([^;]+)/)?.[1];
const project=id=>({projectId:'project-'+id,projectName:'项目 · '+brands.find(b=>b.id===id)?.name,hasCanvas:true,updatedAt:'2026-10-13T08:00:00Z',archiveRevision:0,archivedAt:null});
function json(res,value,status=200,headers={}) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));}
function shell(workspaceId) {
  const context={workspaceId,workspaces:brands.map(({ownerId,...brand})=>brand),user:actor};
  const html=fs.readFileSync(path.join(exported,'studio.html'),'utf8').replace(/<script\b([^>]*)>/g,(_all,attrs)=>`<script type="application/x-novart"${attrs.replace(/\s+type=["'][^"']*["']/g,'')}>`);
  return html.replace('</head>',`<script id="novart-product-context" type="application/json">${JSON.stringify(context)}</script><script defer src="/novart-product-bootstrap.js"></script></head>`);
}
async function body(req) {const chunks=[];for await(const chunk of req)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
async function handle(req,res) {
  const url=new URL(req.url,'http://127.0.0.1'), workspaceId=url.searchParams.get('workspaceId')||cookieBrand(req)||brands[0].id;
  if(url.pathname==='/studio'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(shell(workspaceId));}
  if(url.pathname==='/compare/api/create') { const input=await body(req);assert.equal(req.headers['x-novart-user'],actor.id);writes.push({path:url.pathname,input});let created=creationReceipts.get(input.requestId);if(!created){created={projectId:'created-'+input.requestId,projectName:input.projectName,hasCanvas:false,brief:input.brief,updatedAt:new Date().toISOString(),archiveRevision:0,archivedAt:null};projects.set(created.projectId,created);creationReceipts.set(input.requestId,created);}return json(res,created); }
  if(url.pathname==='/studio/material-upload') {const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks).toString('utf8'),mutationId=req.method==='POST'?raw.match(/name="mutationId"\r?\n\r?\n([^\r\n]+)/)?.[1]:url.searchParams.get('taskId')?.slice(5);assert(mutationId);const projectId=url.searchParams.get('projectId');assert(projects.has(projectId));let value=uploads.get(mutationId);if(!value){value={taskId:'task-'+mutationId,projectId,mutationId,status:'FAILED',progress:0,expiresAt:new Date(Date.now()+360000).toISOString(),error:'Synthetic upload failed'};uploads.set(mutationId,value);}writes.push({path:url.pathname,method:req.method,mutationId});return json(res,value);}
  if(url.pathname==='/fixture/message') {const input=await body(req);if(input.action==='start-creation'){const previous=accepted.get(input.requestId);if(previous)assert.deepEqual(previous,input);else accepted.set(input.requestId,input);return json(res,{status:'accepted'});}return json(res,{status:'saved',revision:1});}
  if(url.pathname==='/api/workspaces') {
    if(req.method==='GET')return json(res,brands);
    const input=await body(req);writes.push({path:url.pathname,input});assert.equal(req.headers['x-novart-user'],actor.id);
    if(failCreate)return json(res,{error:'合成创建失败，当前内容保留'},402);
    const name=input.name.trim();assert.ok(name);const created={id:'brand-switch-'+(brands.length+1),name,ownerId:actor.id,role:'OWNER'};brands.push(created);store(created.id);
    return json(res,created,201,{'Set-Cookie':'brandai-active-brand='+created.id+'; Path=/; SameSite=Lax'});
  }
  if(url.pathname==='/api/workbench/session') {
    if(req.method==='GET')return json(res,{user:actor,workspaces:brands,activeWorkspaceId:workspaceId});
    const input=await body(req);writes.push({path:url.pathname,input});assert.equal(req.headers['x-novart-user'],actor.id);
    if(failSelection)return json(res,{error:'合成切换失败，请重试已有品牌'},503);
    if(!brands.some(b=>b.id===input.workspaceId))return json(res,{error:'Brand not found'},404);
    return json(res,{user:actor,workspaces:brands,activeWorkspaceId:input.workspaceId},200,{'Set-Cookie':'brandai-active-brand='+input.workspaceId+'; Path=/; SameSite=Lax'});
  }
  if(url.pathname==='/studio/state') {
    if(failState&&req.method==='GET')return json(res,{error:'合成读取失败，当前输入仍保留'},503);
    const current=store(workspaceId);if(req.method==='GET')return json(res,current);
    const input=await body(req);writes.push({path:url.pathname,workspaceId,input});assert.equal(input.revision,current.revision);stores.set(workspaceId,{...input,revision:current.revision+1});return json(res,store(workspaceId));
  }
  if(url.pathname==='/studio/project-library')return json(res,{projects:[...projects.values()]});
  if(url.pathname==='/workflow/assets')return json(res,{assets:[]});
  if(url.pathname.endsWith('/notifications'))return json(res,{items:[]});
  if(url.pathname.endsWith('/studio-layer-activity'))return json(res,{requests:[]});
  if(url.pathname==='/canvas'){res.writeHead(307,{Location:'/studio-editor'+url.search});return res.end();}
  if(url.pathname==='/fixture/leave') {const value=await body(req);leaveRequests.push(value);return json(res,{rejected:leaveRejected});}
  if(url.pathname==='/studio-editor') {
    const id=url.searchParams.get('projectId');assert(projects.has(id));res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.end(`<!doctype html><html data-nv-studio-canvas-ready="true"><head><meta charset="utf-8"></head><body><div data-testid="owned-editor">本地合成编辑器回执</div><script>const projectId=${JSON.stringify(id)};parent.postMessage({type:'nv-studio',action:'ready',projectId},location.origin);addEventListener('message',async e=>{const d=e.data;if(e.origin!==location.origin||e.source!==parent||d.type!=='nv-studio'||d.projectId!==projectId||!['confirm-leave','insert-material','start-creation'].includes(d.action))return;const r=await(await fetch('/fixture/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})).json();parent.postMessage({...d,action:d.action+'-result',status:r.status,revision:r.revision},location.origin);});</script></body></html>`);
  }
  if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
  const production={'/novart-product-bootstrap.js':'deploy/novart/studio/novart-product-bootstrap.js','/novart-product-task-inbox.js':'deploy/novart/studio/novart-product-task-inbox.js','/home-start-studio.css':'apps/web/studio-shell/home-start-studio.css','/home-start-studio.js':'apps/web/studio-shell/home-start-studio.js','/home-start-attachments.js':'deploy/novart/studio/novart-owned-home-start.js'};
  // Exercise the old-interface refusal without shipping or loading the removed
  // capture adapter. Use the real owned factory, then remove only its receipt API.
  if(legacyFactory&&url.pathname==='/home-start-attachments.js') {
    const owned=fs.readFileSync(path.join(repo,'deploy/novart/studio/novart-owned-home-start.js'),'utf8');
    res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store'});
    return res.end(owned+`;(()=>{const ownedFactory=window.createHomeStart;window.createHomeStart=function(host){const api=ownedFactory(host);delete api.confirmLeave;return api;};})();`);
  }
  const file=production[url.pathname]?path.join(repo,production[url.pathname]):path.join(exported,url.pathname.slice(1));
  if(path.relative(repo,file).startsWith('..')||!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,{error:'Unavailable isolated route'},404);
  res.writeHead(200,{'Content-Type':{'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.html':'text/html'}[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(fs.readFileSync(file));
}

const check=name=>report.checks.push({name,status:'PASS'});
async function ready(){await page.waitForFunction(()=>window.NovartStudio?.snapshot().stateLoaded&&!window.NovartStudio?.snapshot().metadataBusy&&!document.querySelector('.np-startup')&&NovartStudio.snapshot().homeStart.loaded);}
async function settledHome(){await page.waitForFunction(()=>!NovartStudio.snapshot().homeStart.submittedRequestId&&!NovartStudio.snapshot().homeStart.running.length&&!NovartStudio.snapshot().homeStart.recoveryPending);}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9YoAAAAASUVORK5CYII=','base64');
(async()=>{
  assert(fs.existsSync(path.join(exported,'studio.html')),'Export current owned shell before this test');
  server=http.createServer((req,res)=>handle(req,res).catch(error=>{report.errors.push({kind:'fixture',message:error.message});json(res,{error:'Fixture failed'},500);}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-background-networking','--no-proxy-server']});const context=await browser.newContext({viewport:{width:1366,height:900},serviceWorkers:'block'});await context.route('**/*',route=>{const u=new URL(route.request().url());if(['http:','https:'].includes(u.protocol)&&u.origin!==origin){report.externalRequests.push(u.hostname);return route.abort();}return route.continue();});page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push({kind:'page',message:e.message}));
  stage='actual-shell-failed-upload';await page.goto(origin+'/studio?workspaceId='+brands[0].id+'#/home');await ready();await page.locator('#ns-home-brief').fill('待保留的失败图片需求');await page.locator('#hs-file-input').setInputFiles({name:'shell-failure.png',mimeType:'image/png',buffer:png});await page.waitForFunction(()=>NovartStudio.snapshot().homeStart.attachmentCount===1&&!NovartStudio.snapshot().homeStart.recoveryPending);await page.locator('#ns-create').click();await page.locator('#hs-handoff[data-state="error"]').waitFor();await page.waitForFunction(()=>!NovartStudio.snapshot().homeStart.running.length);assert.equal(creationReceipts.size,1);assert.equal(accepted.size,0);const failedProject=[...creationReceipts.values()][0];assert.equal(await page.evaluate(()=>NovartStudio.snapshot().activeProjectId),failedProject.projectId);check('actual-shell-opens-created-project-and-shows-terminal-upload-failure');
  stage='actual-shell-end-unlocks-editor';await page.getByRole('button',{name:'结束交接并进入项目',exact:true}).click();await settledHome();assert.equal(await page.locator('#hs-handoff').isVisible(),false);const frame=page.locator('iframe[data-project-id="'+failedProject.projectId+'"]');assert.equal(await frame.evaluate(element=>element.inert),false);assert(projects.has(failedProject.projectId));assert.equal(await page.evaluate(()=>NovartStudio.snapshot().homeStart.attachmentCount),1);assert.equal(accepted.size,0);check('ending-failed-handoff-unlocks-original-project-and-keeps-file-without-generation');
  stage='actual-shell-other-project';await page.getByTestId('studio-nav-projects').click();await page.getByRole('button',{name:'打开项目：已有项目',exact:true}).click();await page.waitForFunction(()=>NovartStudio.snapshot().activeProjectId==='existing-project');await page.reload();await ready();await page.waitForFunction(()=>NovartStudio.snapshot().frames.some(f=>f.projectId==='existing-project'&&f.ready));assert.equal(await page.locator('#hs-handoff').isVisible(),false);assert.equal(accepted.size,0);assert.equal(creationReceipts.size,1);check('another-existing-project-opens-and-refreshes-without-replaying-failed-handoff');
  stage='actual-shell-blank-project';await page.getByTestId('studio-nav-home').click();assert.equal(await page.locator('#ns-home-brief').inputValue(),'待保留的失败图片需求');await page.getByRole('button',{name:'移除 shell-failure.png',exact:true}).click();await settledHome();await page.locator('#ns-create-blank').click();await page.waitForFunction(()=>!NovartStudio.snapshot().createBusy&&NovartStudio.snapshot().frames.some(f=>f.active&&f.ready&&f.projectId!=='existing-project'));assert.equal(creationReceipts.size,2);assert.equal(accepted.size,0);const blank=[...creationReceipts.values()].at(-1);assert.equal(blank.brief,'');assert.notEqual(blank.projectId,failedProject.projectId);assert(projects.has(failedProject.projectId));check('actual-shell-creates-and-enters-new-blank-project-while-retaining-failed-project');
  stage='actual-shell-new-creation';await page.getByTestId('studio-nav-home').click();await page.locator('#ns-home-brief').fill('新的海边创作');await page.locator('#ns-create').click();await page.waitForFunction(()=>NovartStudio.snapshot().route.startsWith('/workspace/'));await settledHome();assert.equal(creationReceipts.size,3);assert.equal(accepted.size,1);assert.equal([...accepted.values()][0].text,'新的海边创作');assert(projects.has(failedProject.projectId));await page.reload();await ready();assert.equal(accepted.size,1);check('actual-shell-new-explicit-creation-submits-once-and-old-project-remains');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);report.passed=true;report.createdProjects=creationReceipts.size;report.firstGenerationAcceptances=accepted.size;report.retainedFailedProject=true;
})().catch(async error=>{report.fatal={stage,message:error.message,stack:error.stack};report.diagnostics=await page?.locator('body').innerText().catch(()=>null);process.exitCode=1;}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.writeFileSync(reportPath,JSON.stringify(report,null,2));for(const [key,value]of Object.entries(priorTemp))if(value===undefined)delete process.env[key];else process.env[key]=value;assert.equal(path.dirname(path.resolve(directory)),path.resolve(temporaryRoot));fs.rmSync(directory,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,reportPath,fatal:report.fatal,errors:report.errors}));});

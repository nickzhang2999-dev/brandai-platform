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
const reportPath=process.env.NOVART_BRAND_SWITCH_REPORT || path.join(repo,'.novart-build/reports/brand-switcher-'+Date.now()+'.json');
const temporaryRoot=path.join(repo,'.novart-build/temporary');fs.mkdirSync(temporaryRoot,{recursive:true});
const directory=fs.mkdtempSync(path.join(temporaryRoot,'brand-switcher-')), priorTemp={TEMP:process.env.TEMP,TMP:process.env.TMP};
process.env.TEMP=directory;process.env.TMP=directory;fs.mkdirSync(path.dirname(reportPath),{recursive:true});
const report={isolated:true,realBackend:false,realProvider:false,realAuthentication:false,realOwnedEditor:false,providerCalls:0,
  scope:'Production Studio/bootstrap/CSS with synthetic membership/persistence and iframe ACKs; actual OwnedEditor leave/save is tested in the owned-canvas browser suite',checks:[],errors:[],externalRequests:[],passed:false};
const actor={id:'brand-switch-actor',name:'交互检查',email:''};
const brands=[{id:'brand-switch-one',name:'山海生活',ownerId:actor.id,role:'OWNER'}], stores=new Map();
const writes=[], leaveRequests=[];let server,browser,page,stage='fixture',failCreate=false,failSelection=false,failState=false,leaveRejected=false;
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
  if(url.pathname==='/studio/project-library')return json(res,{projects:[project(workspaceId)]});
  if(url.pathname==='/workflow/assets')return json(res,{assets:[]});
  if(url.pathname.endsWith('/notifications'))return json(res,{items:[]});
  if(url.pathname.endsWith('/studio-layer-activity'))return json(res,{requests:[]});
  if(url.pathname==='/canvas'){res.writeHead(307,{Location:'/studio-editor'+url.search});return res.end();}
  if(url.pathname==='/fixture/leave') {const value=await body(req);leaveRequests.push(value);return json(res,{rejected:leaveRejected});}
  if(url.pathname==='/studio-editor') {
    const id=url.searchParams.get('projectId');res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.end(`<!doctype html><html data-nv-studio-canvas-ready="true"><head><meta charset="utf-8"></head><body><p>品牌切换 iframe 协议测试件</p><script>const projectId=${JSON.stringify(id)};parent.postMessage({type:'nv-studio',action:'ready',projectId},location.origin);addEventListener('message',async e=>{const d=e.data;if(e.origin!==location.origin||e.source!==parent||d.type!=='nv-studio'||d.action!=='confirm-leave'||d.projectId!==projectId)return;const r=await(await fetch('/fixture/leave',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)})).json();parent.postMessage({...d,action:'confirm-leave-result',status:r.rejected?'failed':'saved',error:r.rejected?'合成保存尚未确认':''},location.origin);});</script></body></html>`);
  }
  if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
  const production={'/novart-product-bootstrap.js':'deploy/novart/studio/novart-product-bootstrap.js','/novart-product-task-inbox.js':'deploy/novart/studio/novart-product-task-inbox.js','/home-start-studio.css':'apps/web/studio-shell/home-start-studio.css','/home-start-studio.js':'apps/web/studio-shell/home-start-studio.js','/home-start-attachments.js':'deploy/novart/studio/novart-owned-home-start.js'};
  const file=production[url.pathname]?path.join(repo,production[url.pathname]):path.join(exported,url.pathname.slice(1));
  if(path.relative(repo,file).startsWith('..')||!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,{error:'Unavailable isolated route'},404);
  res.writeHead(200,{'Content-Type':{'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.html':'text/html'}[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(fs.readFileSync(file));
}
const check=(name,details={})=>report.checks.push({name,status:'PASS',...details});
const count=path=>writes.filter(value=>value.path===path).length;
async function ready() {await page.waitForFunction(()=>window.NovartStudio?.snapshot().stateLoaded&&!window.NovartStudio?.snapshot().metadataBusy&&!document.querySelector('.np-startup'));}
async function openMenu() {await page.getByTestId('product-brand-trigger').click();await page.getByTestId('product-brand-menu').waitFor({state:'visible'});}
async function openCreate() {await openMenu();await page.getByTestId('product-brand-add').click();await page.getByRole('dialog',{name:'新增品牌',exact:true}).waitFor();}
(async()=>{
  assert.ok(fs.existsSync(path.join(exported,'studio.html')),'Exported Studio HTML must exist');
  server=http.createServer((req,res)=>handle(req,res).catch(error=>{report.errors.push({kind:'fixture',message:error.message});json(res,{error:'Fixture failed'},500);}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-background-networking','--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
  page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push({kind:'page',message:error.message}));
  stage='single-brand-new-entry';await page.goto(origin+'/studio?workspaceId='+brands[0].id+'#/home');await ready();await openMenu();assert.equal(await page.getByTestId('product-brand-option').count(),1);assert.ok(await page.getByTestId('product-brand-add').isVisible());await page.keyboard.press('Escape');check('one-existing-brand-still-exposes-new-brand-entry');
  stage='cancel';await openCreate();await page.getByRole('textbox',{name:'品牌名称',exact:true}).fill('取消的品牌');await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(count('/api/workspaces'),0);assert.equal(brands.length,1);check('cancel-creates-nothing-and-preserves-current-brand');
  stage='creation-error';failCreate=true;await openCreate();await page.getByRole('textbox',{name:'品牌名称',exact:true}).fill('云端茶饮');await page.getByRole('button',{name:'创建并进入',exact:true}).click();await page.getByRole('dialog',{name:'新增品牌',exact:true}).getByText('合成创建失败，当前内容保留',{exact:true}).waitFor();assert.equal(await page.getByRole('textbox',{name:'品牌名称',exact:true}).inputValue(),'云端茶饮');assert.equal(new URL(page.url()).searchParams.get('workspaceId'),brands[0].id);check('creation-error-is-visible-and-keeps-name-and-original-brand');
  stage='second-brand';failCreate=false;await page.getByRole('button',{name:'重试创建',exact:true}).click();await page.waitForURL('**/studio?workspaceId=brand-switch-2#/brand');await ready();assert.equal(brands.length,2);assert.equal(await page.locator('.np-brand-label').textContent(),'云端茶饮');assert.equal(await page.locator('#ns-brand-name').inputValue(),'云端茶饮');check('create-second-brand-selects-server-cookie-and-brand-specification-url');
  stage='third-brand-lost-selection';failSelection=true;await openCreate();await page.getByRole('textbox',{name:'品牌名称',exact:true}).fill('北岸创意');const before=count('/api/workspaces');await page.getByRole('button',{name:'创建并进入',exact:true}).click();await page.getByRole('dialog',{name:'新增品牌',exact:true}).getByText('品牌已创建，尚未切换。合成切换失败，请重试已有品牌',{exact:true}).waitFor();assert.equal(brands.length,3);assert.equal(count('/api/workspaces'),before+1);assert.equal(new URL(page.url()).searchParams.get('workspaceId'),'brand-switch-2');failSelection=false;await page.getByRole('button',{name:'进入已创建的品牌',exact:true}).click();await page.waitForURL('**/studio?workspaceId=brand-switch-3#/brand');await ready();assert.equal(count('/api/workspaces'),before+1);check('selection-retry-reuses-created-brand-and-does-not-create-a-duplicate');
  stage='three-brand-switch-refresh';await openMenu();assert.equal(await page.getByTestId('product-brand-option').count(),3);await page.locator('.np-brand-option[data-workspace-id="brand-switch-one"]').click();await page.waitForURL('**/studio?workspaceId=brand-switch-one#/home');await ready();await page.reload();await ready();assert.equal(await page.locator('.np-brand-label').textContent(),'山海生活');assert.equal(await page.locator('#ns-brand-name').inputValue(),'山海生活');assert.equal((await context.cookies()).find(c=>c.name==='brandai-active-brand').value,'brand-switch-one');check('three-brands-switch-and-refresh-with-server-cookie-and-pinned-url');
  stage='metadata-read-failure';failState=true;await page.reload();await page.waitForFunction(()=>window.NovartStudio&&!window.NovartStudio.snapshot().metadataBusy&&!document.querySelector('.np-startup'));assert.equal(await page.evaluate(()=>NovartStudio.snapshot().stateLoaded),false);const beforeReadFailure=count('/api/workbench/session');await openMenu();await page.locator('.np-brand-option[data-workspace-id="brand-switch-2"]').click();await page.getByText('当前品牌尚未读取完成，请确认内容已恢复后再切换品牌。',{exact:true}).waitFor();assert.equal(count('/api/workbench/session'),beforeReadFailure);await page.keyboard.press('Escape');failState=false;await page.reload();await ready();check('failed-metadata-restore-blocks-brand-switch-without-a-session-write');
  stage='unsaved-brand-guard';await page.getByTestId('studio-nav-brand').click();await page.locator('#ns-brand-name').fill('尚未保存的品牌草稿');const selectBefore=count('/api/workbench/session');await openMenu();await page.locator('.np-brand-option[data-workspace-id="brand-switch-2"]').click();await page.getByText('请先保存当前品牌规范、偏好或收藏，再切换品牌。',{exact:true}).waitFor();assert.equal(count('/api/workbench/session'),selectBefore);await page.keyboard.press('Escape');assert.equal(await page.locator('#ns-brand-name').inputValue(),'尚未保存的品牌草稿');await page.locator('#ns-brand-save').click();await page.waitForFunction(()=>!NovartStudio.snapshot().brandDirty&&!NovartStudio.snapshot().metadataBusy);check('unsaved-brand-rules-block-switch-before-any-session-write');
  stage='editor-ack-guard';await page.getByTestId('studio-nav-projects').click();await page.locator('#ns-project-library .ns-project-open').first().click();await page.waitForFunction(()=>document.querySelector('#ns-frames iframe[data-ready="true"]'));leaveRejected=true;await openMenu();await page.locator('.np-brand-option[data-workspace-id="brand-switch-2"]').click();await page.getByText('合成保存尚未确认',{exact:true}).waitFor();assert.equal(count('/api/workbench/session'),selectBefore);assert.equal(leaveRequests.length,1);assert.equal(new URL(page.url()).searchParams.get('workspaceId'),'brand-switch-one');leaveRejected=false;await page.locator('.np-brand-option[data-workspace-id="brand-switch-2"]').click();await page.waitForURL('**/studio?workspaceId=brand-switch-2#/home');await ready();assert.equal(leaveRequests.length,2);assert.equal(await page.locator('#ns-brand-name').inputValue(),'云端茶饮');check('editor-save-refusal-keeps-project-open-and-retry-navigates-only-after-valid-ack');
  assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;report.brandCount=brands.length;report.creationPosts=count('/api/workspaces');report.selectionPosts=count('/api/workbench/session');
})().catch(error=>{report.fatal={stage,message:error.message,stack:error.stack};process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  for(const [key,value]of Object.entries(priorTemp))if(value===undefined)delete process.env[key];else process.env[key]=value;
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(temporaryRoot));fs.rmSync(directory,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,reportPath,fatal:report.fatal,errors:report.errors}));
});

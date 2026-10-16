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
const reportPath=process.env.NOVART_HOME_LEAVE_REPORT || path.join(repo,'.novart-build/reports/home-brand-leave-'+Date.now()+'.json');
const temporaryRoot=path.join(repo,'.novart-build/temporary');fs.mkdirSync(temporaryRoot,{recursive:true});
const directory=fs.mkdtempSync(path.join(temporaryRoot,'home-brand-leave-')), priorTemp={TEMP:process.env.TEMP,TMP:process.env.TMP};
process.env.TEMP=directory;process.env.TMP=directory;fs.mkdirSync(path.dirname(reportPath),{recursive:true});
const report={isolated:true,realBackend:false,realProvider:false,realAuthentication:false,realOwnedEditor:false,providerCalls:0,
  scope:'Production Studio/bootstrap/CSS with synthetic membership/persistence and iframe ACKs; actual OwnedEditor leave/save is tested in the owned-canvas browser suite',checks:[],errors:[],externalRequests:[],passed:false};
const actor={id:'brand-switch-actor',name:'交互检查',email:''};
const brands=[{id:'brand-switch-one',name:'山海生活',ownerId:actor.id,role:'OWNER'}], stores=new Map();
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
const check=(name,details={})=>report.checks.push({name,status:'PASS',...details});
const count=path=>writes.filter(value=>value.path===path).length;
async function ready() {await page.waitForFunction(()=>window.NovartStudio?.snapshot().stateLoaded&&!window.NovartStudio?.snapshot().metadataBusy&&!document.querySelector('.np-startup'));}
async function openMenu() {await page.getByTestId('product-brand-trigger').click();await page.getByTestId('product-brand-menu').waitFor({state:'visible'});}
async function openCreate() {await openMenu();await page.getByTestId('product-brand-add').click();await page.getByRole('dialog',{name:'新增品牌',exact:true}).waitFor();}
(async()=>{
  assert.ok(fs.existsSync(path.join(exported,'studio.html')),'Exported Studio HTML must exist');
  server=http.createServer((req,res)=>handle(req,res).catch(error=>{report.errors.push({kind:'fixture',message:error.message});json(res,{error:'Fixture failed'},500);}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  brands.push({id:'brand-switch-two',name:'第二品牌',ownerId:actor.id,role:'OWNER'});
  browser=await chromium.launch({executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-background-networking','--no-proxy-server']});
  const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
  page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push({kind:'page',message:error.message}));
  await page.addInitScript(()=>{
    window.__recoveryHold=false;window.__recoveryReject=false;window.__recoveryReceipts=[];window.__briefReject=false;
    const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){if(window.__recoveryReject&&this.transaction.db.name.includes('novart-owned-home-start'))throw new DOMException('Isolated quota failure','QuotaExceededError');return put.apply(this,args);};
    const transaction=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(...args){const value=transaction.apply(this,args);if(this.name.includes('novart-owned-home-start')&&args[1]==='readwrite')Object.defineProperty(value,'oncomplete',{configurable:true,set(callback){value.addEventListener('complete',event=>{if(window.__recoveryHold)window.__recoveryReceipts.push(()=>callback(event));else callback(event);});}});return value;};
    const setItem=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,...args){if(window.__briefReject&&key.endsWith('novart-m24-home-brief'))throw new DOMException('Isolated quota failure','QuotaExceededError');return setItem.call(this,key,...args);};
  });
  const image=name=>({name,mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64')});
  const select=id=>page.locator('.np-brand-option[data-workspace-id="'+id+'"]').click();
  const switchBack=async()=>{await openMenu();await select('brand-switch-one');await page.waitForURL('**/studio?workspaceId=brand-switch-one#/home');await ready();await page.waitForFunction(()=>NovartStudio.snapshot().homeStart.loaded);};
  await page.goto(origin+'/studio?workspaceId=brand-switch-one#/home');await ready();await page.waitForFunction(()=>NovartStudio.snapshot().homeStart.loaded);
  assert.equal(await page.evaluate(()=>window.createHomeStart.toString().includes("owned-home-start-v1")&&typeof window.NovartStudio.confirmBrandLeave==='function'&&typeof window.NovartStudio.snapshot().homeStart.recoveryPending==='boolean'),true);check('real-Studio-loading-order-installs-owned-home-factory-and-leave-confirmation');
  stage='pending-recovery-receipt';await page.evaluate(()=>{window.__recoveryHold=true;});await page.locator('#hs-file-input').setInputFiles(image('confirmed-original.png'));await page.waitForFunction(()=>NovartStudio.snapshot().homeStart.recoveryPending);
  const beforePending=count('/api/workbench/session');await openMenu();await select('brand-switch-two');await page.waitForTimeout(400);
  assert.equal(count('/api/workbench/session'),beforePending);assert.equal(new URL(page.url()).searchParams.get('workspaceId'),'brand-switch-one');assert.equal(await page.locator('#hs-attachments .hs-attachment').count(),1);
  await page.evaluate(()=>{window.__recoveryHold=false;window.__recoveryReceipts.splice(0).forEach(receipt=>receipt());});
  await page.waitForURL('**/studio?workspaceId=brand-switch-two#/home');await ready();check('pending-IndexedDB-receipt-blocks-session-write-until-transaction-confirms');
  stage='restore-persisted-attachment';await switchBack();assert.equal(await page.locator('#hs-attachments .hs-attachment').count(),1);check('confirmed-original-attachment-restores-after-switch-away-and-back');
  stage='rejected-recovery-preserves-image';await page.evaluate(()=>{window.__recoveryReject=true;});await page.locator('#hs-file-input').setInputFiles(image('memory-only-second.png'));await page.getByText('恢复记录未能保存。请保留本页和原图，恢复存储空间后继续。',{exact:true}).first().waitFor();
  const beforeReject=count('/api/workbench/session');await openMenu();await select('brand-switch-two');await page.locator('.np-brand-status').getByText('恢复记录未能保存。请保留本页和原图，恢复存储空间后继续。',{exact:true}).waitFor();assert.equal(count('/api/workbench/session'),beforeReject);assert.equal(await page.locator('#hs-attachments .hs-attachment').count(),2);assert.equal(new URL(page.url()).searchParams.get('workspaceId'),'brand-switch-one');check('quota-failed-recovery-prevents-switch-and-retains-both-original-files');
  stage='recovery-retry';await page.evaluate(()=>{window.__recoveryReject=false;});await select('brand-switch-two');await page.waitForURL('**/studio?workspaceId=brand-switch-two#/home');await ready();await switchBack();assert.equal(await page.locator('#hs-attachments .hs-attachment').count(),2);check('recovery-after-quota-failure-confirms-both-files-and-allows-switch');
  stage='brief-local-storage-failure';await page.evaluate(()=>{window.__briefReject=true;});await page.locator('#ns-home-brief').fill('不能丢的首页需求');const beforeBrief=count('/api/workbench/session');await openMenu();await select('brand-switch-two');await page.getByText('首页需求暂存未确认，请保留当前页面，恢复存储空间后再切换品牌。',{exact:true}).waitFor();assert.equal(count('/api/workbench/session'),beforeBrief);assert.equal(await page.locator('#ns-home-brief').inputValue(),'不能丢的首页需求');check('failed-home-brief-storage-prevents-switch-and-keeps-text');
  stage='brief-storage-retry';await page.evaluate(()=>{window.__briefReject=false;});await select('brand-switch-two');await page.waitForURL('**/studio?workspaceId=brand-switch-two#/home');await ready();await switchBack();assert.equal(await page.locator('#ns-home-brief').inputValue(),'不能丢的首页需求');check('brief-storage-retry-restores-exact-input-after-brand-switch');
  stage='composition-protocol-guard';await openMenu();await page.locator('#ns-home-brief').dispatchEvent('compositionstart');const beforeComposition=count('/api/workbench/session');await select('brand-switch-two');await page.getByText('请先完成首页的中文输入，再切换品牌。',{exact:true}).waitFor();assert.equal(count('/api/workbench/session'),beforeComposition);await page.locator('#ns-home-brief').dispatchEvent('compositionend');await page.keyboard.press('Escape');check('active-composition-state-prevents-switch-without-session-write',{scope:'Synthetic DOM composition events; not a physical OS IME test'});
  stage='legacy-factory-fail-closed';legacyFactory=true;await page.reload();await ready();await page.waitForFunction(()=>NovartStudio.snapshot().homeStart.loaded);assert.equal(await page.evaluate(()=>window.createHomeStart.toString().includes('owned-home-start-v1')),false);const beforeLegacy=count('/api/workbench/session');await openMenu();await select('brand-switch-two');await page.getByText('首页图片保存组件尚未准备完成，请重新打开当前页面后再切换品牌。',{exact:true}).waitFor();assert.equal(count('/api/workbench/session'),beforeLegacy);check('legacy-home-factory-without-save-confirmation-refuses-switch-with-readable-error');
  assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;report.brandCount=brands.length;report.creationPosts=count('/api/workspaces');report.selectionPosts=count('/api/workbench/session');
})().catch(error=>{report.fatal={stage,message:error.message,stack:error.stack};process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  for(const [key,value]of Object.entries(priorTemp))if(value===undefined)delete process.env[key];else process.env[key]=value;
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(temporaryRoot));fs.rmSync(directory,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,reportPath,fatal:report.fatal,errors:report.errors}));
});

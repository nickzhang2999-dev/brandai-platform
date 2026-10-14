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
const reportPath=process.env.NOVART_BRAND_CREATION_REPORT || path.join(repo,'.novart-build/reports/brand-creation-recovery-'+Date.now()+'.json');
const temporaryRoot=path.join(repo,'.novart-build/temporary');fs.mkdirSync(temporaryRoot,{recursive:true});
const directory=fs.mkdtempSync(path.join(temporaryRoot,'brand-creation-recovery-')), priorTemp={TEMP:process.env.TEMP,TMP:process.env.TMP};
process.env.TEMP=directory;process.env.TMP=directory;fs.mkdirSync(path.dirname(reportPath),{recursive:true});
const report={isolated:true,realBackend:false,realProvider:false,realAuthentication:false,realOwnedEditor:false,providerCalls:0,
  scope:'Production Studio/bootstrap/CSS with synthetic membership/persistence and iframe ACKs; actual OwnedEditor leave/save is tested in the owned-canvas browser suite',checks:[],errors:[],externalRequests:[],passed:false};
const actor={id:'brand-switch-actor',name:'交互检查',email:''};
const brands=[{id:'brand-switch-one',name:'山海生活',ownerId:actor.id,role:'OWNER'}], stores=new Map();
const writes=[], leaveRequests=[], creationReceipts=new Map();let server,browser,page,stage='fixture',failCreate=false,failSelection=false,failState=false,leaveRejected=false,createMode='ok',badListActor=false,brandListReads=0;
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
  const url=new URL(req.url,'http://127.0.0.1'), workspaceId=url.searchParams.get('workspaceId')||cookieBrand(req)||(brands[0]?.id??null);
  if(url.pathname==='/studio'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(shell(workspaceId));}
  if(url.pathname==='/api/workspaces') {
    if(req.method==='GET')return json(res,brands);
    const input=await body(req),mutation=req.headers['x-novart-mutation'];writes.push({path:url.pathname,input,mutation});assert.equal(req.headers['x-novart-user'],actor.id);assert.match(mutation,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
    if(createMode.startsWith('reject-'))return json(res,{error:'明确拒绝创建 '+createMode.slice(7)},Number(createMode.slice(7)));
    if(failCreate)return json(res,{error:'合成创建失败，当前内容保留'},402);
    const name=input.name.trim();assert.ok(name);let created=creationReceipts.get(mutation);if(created)assert.equal(created.name,name);else{created={id:'brand-switch-'+(brands.length+1),name,ownerId:actor.id,role:'OWNER'};brands.push(created);store(created.id);creationReceipts.set(mutation,created);}
    if(createMode==='malformed-201'){res.writeHead(201,{'Content-Type':'text/plain'});return res.end('Interrupted creation receipt');}
    if(createMode==='missing-id-201')return json(res,{name:created.name},201);
    if(createMode==='502')return json(res,{error:'Upstream interrupted'},502);
    if(createMode==='408')return json(res,{error:'Creation receipt timed out'},408);
    if(createMode==='network'){res.destroy();return;}
    return json(res,created,201,{'Set-Cookie':'brandai-active-brand='+created.id+'; Path=/; SameSite=Lax'});
  }
  if(url.pathname==='/api/workbench/session') {
    if(req.method==='GET'){brandListReads++;return json(res,{user:badListActor?{id:'unexpected-actor'}:actor,workspaces:brands,activeWorkspaceId:workspaceId});}
    const input=await body(req);writes.push({path:url.pathname,input});assert.equal(req.headers['x-novart-user'],actor.id);
    assert.equal(req.headers['x-novart-mutation'],undefined);
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
  const production={'/novart-product-bootstrap.js':'deploy/novart/studio/novart-product-bootstrap.js','/novart-product-task-inbox.js':'deploy/novart/studio/novart-product-task-inbox.js','/home-start-studio.css':'previews/novart-workbench/harness/home-start-studio.css','/home-start-studio.js':'previews/novart-workbench/harness/home-start-studio.js','/home-start-attachments.js':'deploy/novart/studio/novart-owned-home-start.js'};
  const file=production[url.pathname]?path.join(repo,production[url.pathname]):path.join(exported,url.pathname.slice(1));
  if(path.relative(repo,file).startsWith('..')||!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,{error:'Unavailable isolated route'},404);
  res.writeHead(200,{'Content-Type':{'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.html':'text/html'}[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(fs.readFileSync(file));
}
const check=(name,details={})=>report.checks.push({name,status:'PASS',...details});
const count=path=>writes.filter(value=>value.path===path).length;
async function ready() {await page.waitForFunction(()=>window.NovartStudio?.snapshot().homeStart.loaded&&window.NovartStudio?.snapshot().stateLoaded&&!window.NovartStudio?.snapshot().metadataBusy&&!document.querySelector('.np-startup'));}
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
  const creation=()=>page.getByRole('dialog',{name:'新增品牌',exact:true});
  const returnToFirst=async()=>{await openMenu();await page.locator('.np-brand-option[data-workspace-id="brand-switch-one"]').click();await page.waitForURL('**/studio?workspaceId=brand-switch-one#/home');await ready();};
  await page.goto(origin+'/studio?workspaceId=brand-switch-one#/home');await ready();
  for(const mode of ['malformed-201','missing-id-201','502','network']) {
    stage='uncertain-'+mode;createMode=mode;await openCreate();const name='回执检查 '+mode;await page.getByRole('textbox',{name:'品牌名称',exact:true}).fill(name);
    const before=count('/api/workspaces'),selections=count('/api/workbench/session'),listReads=brandListReads,brandCount=brands.length;
    await page.getByRole('button',{name:'创建并进入',exact:true}).click();await creation().getByText('品牌创建结果尚未确认，请先检查品牌列表，避免重复创建。',{exact:true}).waitFor();const initialHttpCreationPosts=count('/api/workspaces')-before;assert.equal(brands.length,brandCount+1);if(mode==='network')assert.ok(initialHttpCreationPosts>=1);else assert.equal(initialHttpCreationPosts,1);const keys=writes.filter(write=>write.path==='/api/workspaces').slice(before).map(write=>write.mutation);assert.equal(new Set(keys).size,1);assert.equal(await page.getByRole('textbox',{name:'品牌名称',exact:true}).inputValue(),name);
    assert.equal(await page.getByRole('button',{name:'重试创建',exact:true}).count(),0);
    const existing=brands.at(-1);await page.getByRole('button',{name:'检查品牌列表',exact:true}).click();await page.getByTestId('product-brand-menu').waitFor({state:'visible'});
    assert.equal(brandListReads,listReads+1);assert.equal(count('/api/workspaces'),before+initialHttpCreationPosts);assert.equal(count('/api/workbench/session'),selections);assert.equal(new URL(page.url()).searchParams.get('workspaceId'),'brand-switch-one');assert.equal(await page.getByTestId('product-brand-option').count(),brands.length);
    await page.locator('.np-brand-option[data-workspace-id="'+existing.id+'"]').click();await page.waitForURL('**/studio?workspaceId='+existing.id+'#/home');await ready();assert.equal(count('/api/workspaces'),before+initialHttpCreationPosts);assert.equal(count('/api/workbench/session'),selections+1);createMode='ok';await returnToFirst();check(mode+'-unknown-creation-checks-server-list-without-another-UI-create',{initialHttpCreationPosts,scope:mode==='network'?'TCP-reset transport retransmissions reuse one mutation UUID; the fixture receipt deduplicates them. This does not verify real backend/database idempotency.':'One original creation; checking and selecting never repeat it'});
  }
  for(const status of [400,401,402,403,404,405,409,413,422]) {
    stage='known-rejection-'+status;createMode='reject-'+status;await openCreate();const name='明确失败检查 '+status;await page.getByRole('textbox',{name:'品牌名称',exact:true}).fill(name);const before=brands.length,posts=count('/api/workspaces');await page.getByRole('button',{name:'创建并进入',exact:true}).click();await creation().getByText('明确拒绝创建 '+status,{exact:true}).waitFor();assert.equal(brands.length,before);assert.equal(await page.getByRole('button',{name:'检查品牌列表',exact:true}).count(),0);createMode='ok';await page.getByRole('button',{name:'重试创建',exact:true}).click();await page.waitForURL('**/studio?workspaceId=brand-switch-'+(before+1)+'#/brand');await ready();assert.equal(brands.length,before+1);assert.equal(count('/api/workspaces'),posts+2);const attempts=writes.filter(write=>write.path==='/api/workspaces').slice(posts);assert.notEqual(attempts[0].mutation,attempts[1].mutation);await returnToFirst();check(status+'-confirmed-rejection-keeps-normal-error-and-explicit-retry-with-new-mutation');
  }
  stage='brand-list-identity';createMode='malformed-201';await openCreate();await page.getByRole('textbox',{name:'品牌名称',exact:true}).fill('账户保护检查');await page.getByRole('button',{name:'创建并进入',exact:true}).click();await page.getByRole('button',{name:'检查品牌列表',exact:true}).waitFor();const previousList=await page.getByTestId('product-brand-option').allTextContents(),beforeIdentity=count('/api/workspaces');badListActor=true;await page.getByRole('button',{name:'检查品牌列表',exact:true}).click();await creation().getByText('品牌列表尚未确认，旧列表仍保留，请稍后再次检查。',{exact:true}).waitFor();assert.equal(count('/api/workspaces'),beforeIdentity);assert.deepEqual(await page.getByTestId('product-brand-option').allTextContents(),previousList);badListActor=false;await page.getByRole('button',{name:'检查品牌列表',exact:true}).click();await page.getByTestId('product-brand-menu').waitFor({state:'visible'});await page.keyboard.press('Escape');check('different-user-list-is-rejected-without-overwriting-old-brand-list-or-creating-again');
  stage='first-brand-unknown';brands.length=0;stores.clear();createMode='malformed-201';await context.clearCookies();await page.goto(origin+'/studio#/home');await page.getByRole('textbox',{name:'品牌名称',exact:true}).fill('首次品牌');const firstPosts=count('/api/workspaces');await page.getByRole('button',{name:'进入工作台',exact:true}).click();await page.getByRole('button',{name:'检查品牌列表',exact:true}).waitFor();assert.equal(brands.length,1);await page.getByRole('button',{name:'检查品牌列表',exact:true}).click();await page.getByText('检查已有品牌',{exact:true}).waitFor();assert.equal(count('/api/workspaces'),firstPosts+1);assert.equal(brands.length,1);await page.getByRole('button',{name:'首次品牌',exact:true}).click();await page.waitForURL('**/studio?workspaceId='+brands[0].id+'#/home');await ready();assert.equal(count('/api/workspaces'),firstPosts+1);check('first-brand-unreadable-201-shows-existing-brand-choices-without-duplicate-create');
  assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;report.creationPosts=count('/api/workspaces');report.selectionPosts=count('/api/workbench/session');report.brandListReads=brandListReads;
})().catch(error=>{report.fatal={stage,message:error.message,stack:error.stack};process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  for(const [key,value]of Object.entries(priorTemp))if(value===undefined)delete process.env[key];else process.env[key]=value;
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(temporaryRoot));fs.rmSync(directory,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,reportPath,fatal:report.fatal,errors:report.errors}));
});

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
const brands=[{id:'brand-switch-one',name:'山海生活',ownerId:actor.id,role:'OWNER',canDelete:true}], stores=new Map();
const writes=[], leaveRequests=[];let server,browser,page,stage='fixture',failCreate=false,failSelection=false,failState=false,leaveRejected=false;
let deletionMode='success',impactFails=false,activeTasks=0,impactRevision=1,releaseDeletion;
const deletions=[],deletionReceipts=new Map();
const deletionToken=()=>String(impactRevision).repeat(64);
const impact=brand=>({workspaceId:brand.id,name:brand.name,counts:{projects:impactRevision,assets:4,rules:2,terms:1,prohibitions:0,inspirationCases:0,members:1},activeTasks,canDelete:activeTasks===0,blockedReason:activeTasks?'还有任务正在处理，请等待完成后再删除。':null,confirmationToken:deletionToken()});
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
  const url=new URL(req.url,'http://127.0.0.1'), workspaceId=url.searchParams.get('workspaceId')||cookieBrand(req)||brands[0]?.id||null;
  if(url.pathname==='/studio'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(shell(workspaceId));}
  if(url.pathname==='/api/workspaces') {
    if(req.method==='GET')return json(res,brands);
    const input=await body(req);writes.push({path:url.pathname,input});assert.equal(req.headers['x-novart-user'],actor.id);
    if(failCreate)return json(res,{error:'合成创建失败，当前内容保留'},402);
    const name=input.name.trim();assert.ok(name);const created={id:'brand-switch-'+(brands.length+1),name,ownerId:actor.id,role:'OWNER',canDelete:true};brands.push(created);store(created.id);
    return json(res,created,201,{'Set-Cookie':'brandai-active-brand='+created.id+'; Path=/; SameSite=Lax'});
  }
  const deletionPath=url.pathname.match(/^\/api\/workspaces\/([^/]+)(\/deletion)?$/);
  if(deletionPath){
    const id=deletionPath[1],brand=brands.find(value=>value.id===id);
    if(deletionPath[2]&&req.method==='GET'){
      if(impactFails)return json(res,{error:'合成影响范围读取失败'},503);
      if(!brand)return json(res,{error:'品牌不存在'},404);
      if(!brand.canDelete)return json(res,{error:'只有品牌所有者可删除'},403);
      return json(res,impact(brand));
    }
    if(req.method==='DELETE'){
      const input=await body(req);deletions.push({workspaceId:id,input});assert.equal(req.headers['x-novart-user'],actor.id);
      if(deletionReceipts.has(input.mutationId)){const prior=deletionReceipts.get(input.mutationId);assert.deepEqual(prior.input,input);return json(res,prior.result,200,{'Set-Cookie':prior.cookie});}
      if(deletionMode==='hold')await new Promise(resolve=>{releaseDeletion=resolve;});
      if(deletionMode==='conflict'){impactRevision=2;return json(res,{error:'品牌内容已变化，请重新检查影响范围'},409);}
      if(!brand?.canDelete)return json(res,{error:'只有品牌所有者可删除'},403);
      if(input.confirmationName!==brand.name||input.confirmationToken!==deletionToken()||activeTasks)return json(res,{error:'删除条件已变化，请重新检查'},409);
      assert.match(input.mutationId,/^[a-f0-9-]{36}$/i);brands.splice(brands.indexOf(brand),1);
      const nextWorkspaceId=brands[0]?.id||null,redirectTo=nextWorkspaceId?'/studio?workspaceId='+nextWorkspaceId+'#/home':'/studio';
      const result={ok:true,deletedWorkspaceId:id,nextWorkspaceId,redirectTo},cookie=nextWorkspaceId?'brandai-active-brand='+nextWorkspaceId+'; Path=/; SameSite=Lax':'brandai-active-brand=; Path=/; Max-Age=0';
      deletionReceipts.set(input.mutationId,{input,result,cookie});
      if(deletionMode==='uncertain')return json(res,{error:'合成回执连接中断'},503);
      return json(res,result,200,{'Set-Cookie':cookie});
    }
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
async function openDelete() {await openMenu();await page.getByTestId('product-brand-delete').click();await page.getByTestId('product-delete-brand').waitFor();}
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
  const deleteDialog=()=>page.getByTestId('product-delete-brand'),deleteInput=()=>deleteDialog().getByLabel('输入品牌名称确认删除'),confirmDelete=()=>deleteDialog().getByRole('button',{name:'确认删除',exact:true});
  const currentBrand=()=>brands.find(brand=>brand.id===new URL(page.url()).searchParams.get('workspaceId'));
  stage='delete-owner-only';currentBrand().canDelete=false;await page.reload();await ready();await openMenu();assert.equal(await page.getByTestId('product-brand-delete').count(),0);await page.keyboard.press('Escape');currentBrand().canDelete=true;await page.reload();await ready();check('membership-owner-role-alone-does-not-show-delete-entry');
  stage='delete-confirm-and-cancel';await openDelete();await page.getByTestId('product-delete-impact').getByText(/1 个项目、4 个素材/).waitFor();assert.equal(await confirmDelete().isDisabled(),true);await deleteInput().fill('错误名称');assert.equal(await confirmDelete().isDisabled(),true);await deleteInput().fill(currentBrand().name);assert.equal(await confirmDelete().isEnabled(),true);await page.screenshot({path:reportPath.replace(/\.json$/,'.delete-desktop.png')});await page.setViewportSize({width:390,height:844});const deleteBounds=await deleteDialog().boundingBox();assert.ok(deleteBounds.x>=0&&deleteBounds.x+deleteBounds.width<=390);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:reportPath.replace(/\.json$/,'.delete-mobile.png')});await deleteDialog().getByRole('button',{name:'取消',exact:true}).click();await page.setViewportSize({width:1280,height:800});assert.equal(deletions.length,0);check('delete-shows-project-asset-impact-and-needs-exact-name-cancel-is-read-only');
  stage='delete-impact-failure';impactFails=true;await openDelete();await deleteDialog().getByText('合成影响范围读取失败',{exact:true}).waitFor();await deleteInput().fill(currentBrand().name);assert.equal(await confirmDelete().isDisabled(),true);impactFails=false;await deleteDialog().getByRole('button',{name:'重新检查',exact:true}).click();await page.getByTestId('product-delete-impact').getByText(/1 个项目、4 个素材/).waitFor();assert.equal(await confirmDelete().isEnabled(),true);await deleteDialog().getByRole('button',{name:'取消',exact:true}).click();assert.equal(deletions.length,0);check('failed-impact-read-blocks-delete-and-retry-restores-confirmation');
  stage='delete-active-tasks';activeTasks=1;await openDelete();await deleteDialog().getByText('还有任务正在处理，请等待完成后再删除。',{exact:true}).waitFor();await deleteInput().fill(currentBrand().name);assert.equal(await confirmDelete().isDisabled(),true);await deleteDialog().getByRole('button',{name:'取消',exact:true}).click();activeTasks=0;assert.equal(deletions.length,0);check('active-tasks-block-delete-before-submission');
  stage='delete-dirty-guard';await page.getByTestId('studio-nav-brand').click();await page.locator('#ns-brand-name').fill('保留的未保存内容');await openDelete();await deleteInput().fill(currentBrand().name);await confirmDelete().click();await deleteDialog().getByText('请先保存当前品牌规范、偏好或收藏，再切换品牌。',{exact:true}).waitFor();assert.equal(deletions.length,0);await deleteDialog().getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.locator('#ns-brand-name').inputValue(),'保留的未保存内容');await page.locator('#ns-brand-save').click();await page.waitForFunction(()=>!NovartStudio.snapshot().brandDirty&&!NovartStudio.snapshot().metadataBusy);check('delete-reuses-unsaved-brand-guard-and-preserves-draft');
  stage='delete-editor-guard';await page.getByTestId('studio-nav-projects').click();await page.locator('#ns-project-library .ns-project-open').first().click();await page.waitForFunction(()=>document.querySelector('#ns-frames iframe[data-ready="true"]'));leaveRejected=true;await openDelete();await deleteInput().fill(currentBrand().name);await confirmDelete().click();await deleteDialog().getByText('合成保存尚未确认',{exact:true}).waitFor();assert.equal(deletions.length,0);await deleteDialog().getByRole('button',{name:'取消',exact:true}).click();leaveRejected=false;check('delete-waits-for-open-editor-save-ack-without-removing-current-project');
  stage='delete-impact-conflict';deletionMode='conflict';await openDelete();await deleteInput().fill(currentBrand().name);await confirmDelete().click();await deleteDialog().getByText('品牌内容已变化，请重新检查影响范围',{exact:true}).waitFor();assert.equal(await deleteInput().inputValue(),'');assert.equal(await confirmDelete().isDisabled(),true);assert.equal(brands.length,3);await deleteDialog().getByRole('button',{name:'重新检查',exact:true}).click();await page.getByTestId('product-delete-impact').getByText(/2 个项目、4 个素材/).waitFor();assert.equal(await confirmDelete().isDisabled(),true);assert.equal(deletions.length,1);await deleteDialog().getByRole('button',{name:'取消',exact:true}).click();check('changed-server-impact-requires-fresh-counts-and-name-confirmation');
  stage='delete-pending-protection';deletionMode='hold';await openDelete();await deleteInput().fill(currentBrand().name);await confirmDelete().click();await page.waitForFunction(()=>document.querySelector('[data-testid="product-delete-brand"] button[type="submit"]').disabled);while(!releaseDeletion)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(await deleteInput().isDisabled(),true);assert.equal(await deleteDialog().getByRole('button',{name:'取消',exact:true}).isDisabled(),true);await page.keyboard.press('Escape');assert.equal(await deleteDialog().isVisible(),true);assert.equal(deletions.length,2);deletionMode='uncertain';releaseDeletion();await deleteDialog().getByText('删除结果尚未确认，请检查上次删除结果；不会发起新的删除。',{exact:true}).waitFor();assert.equal(await deleteDialog().getByRole('button',{name:'检查上次删除结果',exact:true}).isEnabled(),true);check('pending-delete-disables-input-cancel-and-escape-and-unknown-result-has-recovery');
  stage='delete-receipt-replay';const priorDeletion=deletions.at(-1);await deleteDialog().getByRole('button',{name:'取消',exact:true}).click();await openDelete();assert.equal(await deleteInput().inputValue(),priorDeletion.input.confirmationName);assert.equal(await deleteInput().isDisabled(),true);await deleteDialog().getByRole('button',{name:'检查上次删除结果',exact:true}).click();await page.waitForURL('**/studio?workspaceId=brand-switch-one#/home');await ready();assert.deepEqual(deletions.at(-1),priorDeletion);assert.notEqual(priorDeletion.input.mutationId,deletions[0].input.mutationId);assert.equal(brands.length,2);assert.equal((await context.cookies()).find(c=>c.name==='brandai-active-brand').value,'brand-switch-one');assert.equal(await page.locator('#ns-frames iframe').count(),0);check('unknown-delete-reopens-original-request-and-only-server-receipt-switches-brand');
  stage='delete-last-brand';deletionMode='success';brands.splice(1);await page.reload();await ready();await openDelete();await deleteInput().fill(currentBrand().name);await confirmDelete().click();await page.waitForURL(origin+'/studio');await page.getByRole('heading',{name:'创建你的第一个品牌'}).waitFor();assert.equal(brands.length,0);assert.equal((await context.cookies()).some(c=>c.name==='brandai-active-brand'),false);assert.equal(await page.getByTestId('product-brand-trigger').count(),0);assert.equal(new URL(page.url()).search,'');check('last-brand-deletion-enters-real-empty-studio-and-clears-scoped-cookie');
  assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;report.brandCount=brands.length;report.creationPosts=count('/api/workspaces');report.selectionPosts=count('/api/workbench/session');report.deletionRequests=deletions.length;
})().catch(error=>{report.fatal={stage,message:error.message,stack:error.stack};process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  for(const [key,value]of Object.entries(priorTemp))if(value===undefined)delete process.env[key];else process.env[key]=value;
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(temporaryRoot));fs.rmSync(directory,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,reportPath,fatal:report.fatal,errors:report.errors}));
});

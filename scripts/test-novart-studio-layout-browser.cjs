/* Actual exported Studio shell/bootstrap/inbox, isolated loopback data.
 * The iframe is a protocol fixture, not the editor acceptance test. No account,
 * provider, database, browser profile or Mac/Safari installation is used. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium, webkit} = require('playwright-core');
const repo = path.resolve(__dirname, '..');
const exported = path.join(repo, '.novart-build/studio');
const reportPath = process.env.NOVART_STUDIO_LAYOUT_REPORT || path.join(repo, '.novart-build/reports/studio-layout-' + Date.now() + '.json');
const report = {isolated:true, realBackend:false, realProvider:false, realAuthentication:false, realOwnedEditor:false, providerCalls:0,
  scope:'Exported Studio HTML and actual production bootstrap/CSS/task inbox, synthetic in-memory API and iframe protocol only',
  platform:'Windows headless Chromium; CSS viewport and DPR emulation are not a Mac/Safari device test', checks:[], errors:[], externalRequests:[], writeRequests:0, passed:false};
const context = {workspaceId:'layout-brand-one', workspaces:[{id:'layout-brand-one',name:'山海生活 · 自然产品品牌',role:'OWNER'},{id:'layout-brand-two',name:'第二个独立品牌',role:'OWNER'}],user:{id:'layout-actor',name:'交互检查',email:''}};
const project = {projectId:'layout-project',projectName:'布局回归项目',hasCanvas:true,updatedAt:'2026-10-13T08:00:00Z',archiveRevision:0,archivedAt:null};
let server, browser, stage = 'fixture', cacheScenario;
fs.mkdirSync(path.dirname(reportPath),{recursive:true});
const temporaryRoot = path.join(repo, '.novart-build/temporary');
fs.mkdirSync(temporaryRoot,{recursive:true});
const directory = fs.mkdtempSync(path.join(temporaryRoot,'studio-layout-'));
const priorTemp = {TEMP:process.env.TEMP,TMP:process.env.TMP};
process.env.TEMP = directory; process.env.TMP = directory;
function json(res,value,status=200) {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function shell() {
  const html = fs.readFileSync(path.join(exported,'studio.html'),'utf8');
  const deferred = html.replace(/<script\b([^>]*)>/g,(_all,attrs)=>`<script type="application/x-novart"${attrs.replace(/\s+type=["'][^"']*["']/g,'')}>`);
  return deferred.replace('</head>',`<script id="novart-product-context" type="application/json">${JSON.stringify(context)}</script><script defer src="/novart-product-bootstrap.js"></script></head>`);
}
function handle(req,res) {
  const url = new URL(req.url,'http://127.0.0.1');
  if (!['GET','HEAD'].includes(req.method)) {report.writeRequests++;return json(res,{error:'Layout tests must not write'},405);}
  if (url.pathname === '/studio' || url.pathname === '/studio-cache-prime') {
    res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');
    // Cache verification cannot use Playwright routing (it disables the HTTP
    // cache). Keep that context isolated with a same-origin CSP instead.
    if(cacheScenario)res.setHeader('Content-Security-Policy',"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'");
    const html=shell();
    return res.end(url.pathname==='/studio-cache-prime'?html.replace(/href="\/home-start-studio\.css(?:\?[^"]*)?"/,'href="/home-start-studio.css"'):html);
  }
  if (url.pathname === '/studio/state') return json(res,{revision:0,profile:{nickname:'交互检查',density:'comfortable',motion:'reduce'},brand:{name:context.workspaces[0].name,colors:['#7C5CFF','#202028','#F6F4FC'],font:'sans',notes:''},favorites:[]});
  if (url.pathname === '/studio/project-library') return json(res,{projects:[project]});
  if (url.pathname === '/workflow/assets') return json(res,{assets:[]});
  if (url.pathname === '/api/workspaces') return json(res,{workspaces:context.workspaces});
  if (url.pathname === '/api/workbench/session') return json(res,{...context,activeWorkspaceId:context.workspaceId});
  if (url.pathname.endsWith('/notifications')) return json(res,{items:[]});
  if (url.pathname.endsWith('/inspiration/activity')) return json(res,{enabled:false,items:[]});
  if (url.pathname.endsWith('/studio-layer-activity')) return json(res,{requests:Array.from({length:12},(_,i)=>({requestId:'layout-task-'+i,projectId:project.projectId,status:'RUNNING',createdAt:'2026-10-13T08:00:00Z',expiresAt:'2026-10-14T08:00:00Z',layerCount:4}))});
  if (url.pathname === '/canvas') {res.writeHead(307,{Location:'/studio-editor'+url.search});return res.end();}
  if (url.pathname === '/studio-editor') {res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(`<!doctype html><html data-nv-studio-canvas-ready="true"><head><meta charset="utf-8"></head><body style="margin:0;height:100vh;background:#fafafc"><div data-testid="owned-editor">布局用 iframe 协议测试件</div><section data-testid="fixture-materials" hidden>素材面板协议测试件</section><script>const projectId=${JSON.stringify(project.projectId)};window.panelReceipts=[];addEventListener('message',e=>{const d=e.data;if(e.origin!==location.origin||e.source!==parent||d.type!=='nv-studio'||d.action!=='open-panel'||d.projectId!==projectId)return;panelReceipts.push(d);if(d.panel==='materials')document.querySelector('[data-testid="fixture-materials"]').hidden=false;});parent.postMessage({type:'nv-studio',action:'ready',projectId},location.origin);</script></body></html>`);}
  if (url.pathname === '/favicon.ico') {res.writeHead(204);return res.end();}
  const production = {
    '/novart-product-bootstrap.js':'deploy/novart/studio/novart-product-bootstrap.js',
    '/novart-product-task-inbox.js':'deploy/novart/studio/novart-product-task-inbox.js',
  };
  const file = production[url.pathname] ? path.join(repo,production[url.pathname]) : path.join(exported,url.pathname.slice(1));
  if (path.relative(repo,file).startsWith('..') || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res,{error:'Unavailable isolated route'},404);
  const mime = {'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.html':'text/html'}[path.extname(file)] || 'application/octet-stream';
  if(cacheScenario && url.pathname==='/home-start-studio.css') {
    let body=fs.readFileSync(file,'utf8');
    if(!url.search) {
      cacheScenario.unversionedRequests++;
      const marker=body.indexOf('/* One compact mode selector');
      assert.ok(marker>=0,'Old-cache fixture must remove the real mode-selector styles');
      body=body.slice(0,marker);
    } else cacheScenario.versionedRequests.push(url.pathname+url.search);
    res.writeHead(200,{'Content-Type':mime,'Cache-Control':'public, max-age=14400, must-revalidate'});return res.end(body);
  }
  res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'});return res.end(fs.readFileSync(file));
}
function check(name,details) {report.checks.push({name,status:'PASS',...details});}
async function measure(page,selectors) {
  return page.evaluate(selectors=>Object.fromEntries(selectors.map(selector=>{
    const node=document.querySelector(selector),rect=node?.getBoundingClientRect(),style=node&&getComputedStyle(node);
    return [selector,rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom,display:style.display,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth}:null];
  })),selectors);
}
async function verifyModeAppearance(page,selectedId) {
  const appearance=await page.evaluate(()=>{
    const read=node=>{
      const style=getComputedStyle(node),box=node.getBoundingClientRect();
      return {display:style.display,gap:parseFloat(style.gap),radius:parseFloat(style.borderTopLeftRadius),paddingTop:parseFloat(style.paddingTop),paddingLeft:parseFloat(style.paddingLeft),height:box.height,width:box.width,x:box.x,right:box.right,y:box.y,background:style.backgroundColor,color:style.color,fontSize:parseFloat(style.fontSize),alignItems:style.alignItems};
    };
    const container=read(document.querySelector('.ns-creation-switch'));
    const buttons=['ns-mode-image','ns-mode-copywriting'].map(id=>{
      const node=document.getElementById(id),icon=node.firstElementChild.getBoundingClientRect(),label=node.lastElementChild.getBoundingClientRect();
      return {id,...read(node),iconGap:label.x-icon.right,iconCenter:icon.y+icon.height/2,labelCenter:label.y+label.height/2};
    });
    return {container,buttons};
  });
  const container=appearance.container;
  assert.equal(container.display,'flex','Mode options must share a flex pill, not unstyled inline buttons');
  assert.ok(container.gap>=5 && container.gap<=8,'Mode options need a visible gap');
  assert.ok(container.radius>=container.height/2,'Mode container must stay rounded');
  assert.ok(container.paddingTop>=4 && container.paddingLeft>=4,'Mode container needs inner padding');
  for(const button of appearance.buttons) {
    assert.equal(button.display,'flex',button.id+' must align its icon and label horizontally');
    assert.equal(button.alignItems,'center');
    assert.ok(button.height>=44 && button.height<=48,button.id+' must keep its 44px hit target');
    assert.ok(button.radius>=button.height/2,button.id+' must stay rounded');
    assert.ok(button.gap>=7 && button.gap<=10 && button.iconGap>=7,button.id+' icon and label must not touch');
    assert.ok(Math.abs(button.iconCenter-button.labelCenter)<=1,button.id+' icon and label must be vertically aligned');
    assert.ok(button.paddingLeft>=16 && button.paddingTop>=9,button.id+' needs padded contents');
    assert.equal(button.fontSize,14,button.id+' must use the mode-selector typography');
    assert.ok(button.x>=container.x && button.right<=container.right,'Mode buttons must fit inside their shared pill');
  }
  const selected=appearance.buttons.find(button=>button.id===selectedId),other=appearance.buttons.find(button=>button.id!==selectedId);
  assert.ok(selected && other);
  assert.notEqual(selected.background,'rgba(0, 0, 0, 0)','Selected mode must have a visible filled background');
  assert.notEqual(selected.background,other.background,'Selected and unselected modes need distinct backgrounds');
  assert.notEqual(selected.color,other.color,'Selected mode must retain its accent text');
  return appearance;
}
async function verifyFreshOldCssCache(browser,origin) {
  stage='fresh-old-css-cache';cacheScenario={unversionedRequests:0,versionedRequests:[]};
  const ctx=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
  const page=await ctx.newPage();page.setDefaultTimeout(9000);
  // Expose the real mode-save/focus handoff even on fast local disks. Only
  // delay completion delivery; the browser still performs actual IndexedDB IO.
  await page.addInitScript(()=>{
    const descriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'oncomplete');
    Object.defineProperty(IDBTransaction.prototype,'oncomplete',{...descriptor,set(handler){
      descriptor.set.call(this,typeof handler==='function'?function(event){
        setTimeout(()=>handler.call(this,event),500);
      }:handler);
    }});
  });
  // Do not add ctx.route/page.route here: real fresh-cache reuse is the subject.
  page.on('request',request=>{if(new URL(request.url()).origin!==origin)report.externalRequests.push(request.url());});
  page.on('pageerror',e=>report.errors.push({stage,message:e.message}));
  const ready=()=>page.waitForFunction(()=>window.NovartStudio?.snapshot().homeStart.loaded&&!document.querySelector('.np-startup'));
  try {
    await page.goto(origin+'/studio-cache-prime?pass=1&workspaceId='+context.workspaceId+'#/home');await ready();
    assert.equal(cacheScenario.unversionedRequests,1,'Prime the old unversioned stylesheet through the real HTTP cache');
    assert.equal(await page.locator('.ns-creation-switch').evaluate(node=>getComputedStyle(node).display),'block','Cached fixture must reproduce the missing selector styles');
    await page.goto(origin+'/studio-cache-prime?pass=2&workspaceId='+context.workspaceId+'#/home');await ready();
    assert.equal(cacheScenario.unversionedRequests,1,'A second document must reuse the still-fresh cached CSS without contacting the server');
    assert.equal(await page.locator('#ns-mode-copywriting').evaluate(node=>getComputedStyle(node).borderRadius),'0px','Old cache must retain the broken square buttons');
    await page.goto(origin+'/studio?workspaceId='+context.workspaceId+'#/home');await ready();
    const appearance=await verifyModeAppearance(page,'ns-mode-image');
    const href=await page.locator('link[rel="stylesheet"][href*="home-start-studio.css"]').getAttribute('href');
    assert.match(new URL(href,origin).searchParams.get('novart_sha256')||'',/^[a-f0-9]{64}$/,'New HTML must address CSS by its content version');
    assert.equal(cacheScenario.unversionedRequests,1,'New HTML must not request the stale fixed URL again');
    assert.deepEqual(cacheScenario.versionedRequests,[href],'New CSS must actually be fetched from its distinct versioned URL');
    await page.locator('#ns-mode-copywriting').click();
    await page.waitForFunction(()=>document.querySelector('#ns-mode-copywriting').getAttribute('aria-pressed')==='true');
    await verifyModeAppearance(page,'ns-mode-copywriting');
    // aria-pressed updates before IndexedDB commits. changeMode then focuses
    // the composer; let that real handoff finish before testing keyboard Tab,
    // otherwise slow CI storage can steal focus after this test sets it.
    await page.waitForFunction(()=>document.querySelector('#ns-mode-copywriting').getAttribute('aria-disabled')==='false'
      && document.activeElement===document.querySelector('#ns-home-brief'));
    // The focus ring remains visible and follows the rounded button after the
    // cache fix; keyboard accessibility must not be removed to hide the square.
    await page.locator('#ns-mode-image').focus();await page.keyboard.press('Tab');
    const focus=await page.locator('#ns-mode-copywriting').evaluate(node=>{const style=getComputedStyle(node);return {active:document.activeElement===node,visible:node.matches(':focus-visible'),outline:parseFloat(style.outlineWidth),radius:parseFloat(style.borderRadius)};});
    assert.ok(focus.active && focus.visible && focus.outline>=2 && focus.radius>=22,'Keyboard focus must remain visibly rounded: '+JSON.stringify(focus));
    report.freshOldCssCache={passed:true,...cacheScenario,appearance,keyboardFocus:focus};
  } finally {await ctx.close();cacheScenario=undefined;}
}
async function verifyViewport(browser,spec,origin) {
  stage = spec.name;
  const ctx = await browser.newContext({viewport:{width:spec.width,height:spec.height},deviceScaleFactor:spec.dpr || 1,locale:'zh-CN',reducedMotion:'reduce',serviceWorkers:'block'});
  await ctx.route('**/*',route=>{if(new URL(route.request().url()).origin !== origin){report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
  const page = await ctx.newPage();page.setDefaultTimeout(9000);page.on('pageerror',e=>report.errors.push({stage:spec.name,message:e.message}));
  try {
    await page.goto(origin+'/studio?workspaceId='+context.workspaceId+'#/home');
    await page.waitForFunction(()=>window.NovartStudio?.snapshot().stateLoaded && window.NovartStudio?.snapshot().projectCount===1 && !document.querySelector('.np-startup'));
    const imageModeAppearance=await verifyModeAppearance(page,'ns-mode-image');
    await page.locator('#ns-mode-copywriting').click();
    await page.waitForFunction(()=>document.querySelector('#ns-mode-copywriting').getAttribute('aria-pressed')==='true');
    assert.equal(await page.locator('#ns-create span').textContent(),'进入文案创作');
    const copyModeAppearance=await verifyModeAppearance(page,'ns-mode-copywriting');
    await page.locator('#ns-home-brief').fill('保留这份草稿');
    await page.getByRole('button',{name:'品牌口号',exact:true}).click();
    assert.match(await page.locator('#ns-home-brief').inputValue(),/保留这份草稿/);
    assert.match(await page.locator('#ns-home-brief').inputValue(),/口号/);
    const switchBox=await page.locator('.ns-creation-switch').boundingBox();
    assert.ok(switchBox.x>=0 && switchBox.x+switchBox.width<=spec.width+1);
    if(spec.width===1440) await page.screenshot({path:reportPath.replace(/\.json$/i,'')+'-home-copywriting.png'});
    await page.reload();await page.waitForFunction(()=>document.querySelector('#ns-mode-copywriting').getAttribute('aria-pressed')==='true');
    await page.locator('#ns-mode-image').click();
    assert.equal(await page.locator('#ns-create span').textContent(),'开始创作');
    assert.match(await page.locator('#ns-home-brief').inputValue(),/保留这份草稿/);
    const home = await measure(page,['.ns-sidebar','.np-brand-trigger','.np-brand-label','.np-brand-initial','.np-brand-chevron','.np-inbox-trigger','.np-inbox-label']);
    assert.ok(home['.np-brand-trigger'].scrollWidth<=home['.np-brand-trigger'].clientWidth+1,'Long brand names must fit the home switcher');
    for (const selector of ['.np-brand-trigger','.np-brand-initial','.np-brand-chevron','.np-inbox-trigger']) {
      const value=home[selector],rail=home['.ns-sidebar'];assert.ok(value&&value.x>=rail.x-1&&value.right<=rail.right+1,'Home '+selector+' must fit its rail');
    }
    if(spec.width<=960){assert.equal(home['.np-brand-label'].display,'none');assert.equal(home['.np-inbox-label'].display,'none');}
    else{assert.notEqual(home['.np-brand-label'].display,'none');assert.notEqual(home['.np-inbox-label'].display,'none');}
    await page.getByTestId('studio-nav-projects').click();
    await page.locator('#ns-project-library [data-project-id="layout-project"] .ns-project-open').click();
    await page.waitForFunction(()=>document.body.dataset.page==='workspace' && document.querySelector('iframe[data-ready="true"]'));
    const values = await measure(page,['.ns-sidebar','.ns-wordmark','.np-brand-trigger','.np-brand-label','.np-brand-initial','.np-brand-chevron','.np-inbox-trigger','.np-inbox-label','.np-inbox-count','#ns-frames']);
    const sidebar = values['.ns-sidebar'];assert.ok(sidebar.width >= 54 && sidebar.width <= 66,'Canvas rail must stay compact in CSS pixels');
    assert.ok(Math.abs(sidebar.height-spec.height)<=1,'Rail follows current viewport height');
    assert.equal(values['.np-inbox-label'].display,'none','Workspace task text must not wrap even on wide desktop');
    assert.equal(values['.np-brand-label'].display,'none','Native select text cannot be crammed into the workspace rail');
    assert.notEqual(values['.np-brand-initial'].display,'none','The current brand remains visibly identifiable');
    for (const selector of ['.ns-wordmark','.np-brand-trigger','.np-brand-initial','.np-brand-chevron','.np-inbox-trigger','.np-inbox-count']) {
      const value=values[selector];assert.ok(value&&value.x>=sidebar.x-1&&value.right<=sidebar.right+1,selector+' must fit the rail');
    }
    assert.ok(values['.np-brand-trigger'].width>=32,'Brand trigger remains clickable');
    assert.ok(values['.np-brand-trigger'].scrollWidth<=values['.np-brand-trigger'].clientWidth+1,'Brand button contents cannot escape its hit target');
    assert.ok(values['.np-inbox-trigger'].height>=40,'Task trigger remains clickable');
    assert.ok(Math.abs(values['#ns-frames'].x-sidebar.right)<=1,'Canvas starts after the rail without a gap or overlap');
    assert.equal(await page.locator('.np-inbox-count').textContent(),'9+');
    assert.match(await page.locator('.np-inbox-trigger').getAttribute('title'),/12项进行中/);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Page cannot overflow horizontally');
    await page.locator('.np-brand-trigger').click();
    await page.locator('.np-brand-menu').waitFor({state:'visible'});
    const menu = (await measure(page,['.np-brand-menu']))['.np-brand-menu'];
    assert.ok(menu.x>=0&&menu.right<=spec.width+1&&menu.y>=0&&menu.bottom<=spec.height+1,'Brand popover must remain inside the viewport');
    await page.keyboard.press('Escape');
    await page.locator('.np-brand-menu').waitFor({state:'hidden'});
    await page.getByTestId('product-task-inbox-trigger').click();
    await page.getByTestId('product-task-inbox').waitFor({state:'visible'});
    const inbox=(await measure(page,['.np-task-inbox']))['.np-task-inbox'];assert.ok(inbox.x>=0&&inbox.right<=spec.width+1&&inbox.y>=0&&inbox.bottom<=spec.height+1,'Task popover must remain inside the viewport');
    await page.keyboard.press('Escape');
    const shot = reportPath.replace(/\.json$/i,'')+'-'+spec.name+'.png';await page.screenshot({path:shot});
    // The old upload deep link must immediately open the owned materials
    // panel, retaining server workspace/build context. No synthetic click may
    // launch a file picker across navigation or wait for retired SDK controls.
    let fileChoosers=0;page.on('filechooser',()=>fileChoosers++);
    await page.goto(origin+'/studio?workspaceId='+context.workspaceId+'&build=owned-shell-regression&panel=upload#/workspace/'+project.projectId);
    await page.waitForFunction(()=>document.querySelector('iframe[data-ready="true"]'));
    await page.frameLocator('#ns-frames iframe').getByTestId('fixture-materials').waitFor({state:'visible'});
    const ownedFrame=page.frames().find(frame=>new URL(frame.url()).pathname==='/studio-editor');assert.ok(ownedFrame);
    assert.equal(await ownedFrame.evaluate(()=>window.panelReceipts.length),1);
    assert.equal(await ownedFrame.evaluate(()=>window.panelReceipts[0].panel),'materials');
    const deepLink=new URL(page.url());assert.equal(deepLink.searchParams.get('workspaceId'),context.workspaceId);assert.equal(deepLink.searchParams.get('build'),'owned-shell-regression');assert.equal(deepLink.searchParams.has('panel'),false);
    assert.equal(new URL(ownedFrame.url()).searchParams.get('workspaceId'),context.workspaceId);
    await ownedFrame.evaluate(()=>parent.postMessage({type:'nv-studio',action:'ready',projectId},location.origin));await page.waitForTimeout(100);
    assert.equal(await ownedFrame.evaluate(()=>window.panelReceipts.length),1,'Repeated ready cannot repeat the consumed upload command');
    assert.equal(fileChoosers,0,'Navigation opens a panel; only a real user upload click can open the picker');
    check(spec.name,{viewport:spec,dpr:spec.dpr||1,modeAppearance:{image:imageModeAppearance,copywriting:copyModeAppearance},homeMeasurements:home,measurements:values,screenshot:shot,uploadDeepLink:'owned-materials-panel-once-with-retained-workspace'});
  } finally {await ctx.close();}
}
async function verifyModeRecovery(browser,origin) {
  stage='mode-recovery';
  const ctx=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
  const page=await ctx.newPage();page.setDefaultTimeout(9000);
  const ready=()=>page.waitForFunction(()=>window.NovartStudio?.snapshot().homeStart.loaded&&!window.NovartStudio.snapshot().homeStart.checkingRecovery&&!document.querySelector('.np-startup'));
  async function seed(started) {
    await page.evaluate(async({workspaceId,projectId,started})=>{
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('novart-owned-home-start',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const requestId=crypto.randomUUID();window.testOriginalRequestId=requestId;
      await new Promise((resolve,reject)=>{const tx=db.transaction('draft','readwrite');tx.objectStore('draft').put({version:1,creationMode:'image',items:[],submitted:{requestId,projectId,brief:'旧需求和原项目必须保留',projectName:'原项目',startCreation:true,creationStarted:started,creationAccepted:false}},'owned-home-start-v1:'+workspaceId);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
    },{workspaceId:context.workspaceId,projectId:project.projectId,started});
    await page.reload();await ready();
  }
  try {
    await page.goto(origin+'/studio?workspaceId='+context.workspaceId+'#/home');await ready();
    await seed(false);
    const original=await page.evaluate(()=>window.NovartStudio.snapshot().homeStart.submittedRequestId);
    assert.equal(await page.locator('#ns-mode-copywriting').evaluate(node=>node.disabled),false,'Blocked mode must remain focusable to explain the recovery action');
    await page.locator('#ns-mode-copywriting').click({force:true});
    assert.match(await page.locator('#ns-home-mode-status').textContent(),/上次项目尚未交接完成/);
    assert.equal(await page.evaluate(()=>window.NovartStudio.snapshot().homeStart.submittedRequestId),original);
    await page.locator('#ns-home-mode-status').getByRole('button',{name:'保留原项目并切换文案',exact:true}).click();
    await page.waitForFunction(()=>window.NovartStudio.snapshot().homeStart.creationMode==='copywriting'&&!window.NovartStudio.snapshot().homeStart.submittedRequestId);
    assert.equal(await page.locator('#ns-home-brief').inputValue(),'旧需求和原项目必须保留');
    check('safe old handoff exposes explicit mode recovery without creating another project');
    await seed(true);await page.locator('#ns-mode-copywriting').click({force:true});
    assert.match(await page.locator('#ns-home-mode-status').textContent(),/提交结果还未确认/);
    assert.equal(await page.locator('#ns-home-mode-status').getByRole('button',{name:'保留原项目并切换文案',exact:true}).count(),0);
    assert.equal(await page.locator('#ns-home-mode-status').getByRole('button',{name:'继续原项目',exact:true}).count(),1);
    assert.equal(await page.locator('#ns-mode-image').getAttribute('aria-pressed'),'true');
    check('unknown submission keeps original request and only offers its continuation');
  } finally {await ctx.close();}
  const failing=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
  try {
    const page=await failing.newPage();await page.goto(origin+'/studio?workspaceId='+context.workspaceId+'#/home');
    await page.waitForFunction(()=>window.NovartStudio?.snapshot().homeStart.loaded&&!document.querySelector('.np-startup'));
    await page.locator('#ns-home-brief').fill('存储故障也保留这份需求');
    await page.evaluate(()=>{IDBObjectStore.prototype.put=function(){throw new DOMException('Isolated quota failure','QuotaExceededError');};});
    await page.locator('#ns-mode-copywriting').click();
    await page.waitForFunction(()=>document.querySelector('#ns-home-mode-status').textContent.includes('创作类型未能保存'));
    assert.equal(await page.locator('#ns-mode-image').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#ns-home-brief').inputValue(),'存储故障也保留这份需求');
    assert.match(await page.locator('#ns-home-mode-status').textContent(),/仍保持图片创作/);
    check('storage failure reports unchanged mode beside the controls and preserves text');
  } finally {await failing.close();}
}
(async()=>{
  assert.ok(fs.existsSync(path.join(exported,'studio.html')),'Build Studio export before this interaction regression');
  report.webkitAvailable = fs.existsSync(webkit.executablePath());
  report.webkitRun = false;
  server=http.createServer((req,res)=>{try{handle(req,res);}catch(e){report.errors.push({kind:'fixture',message:e.message});json(res,{error:'Fixture failed'},500);}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-background-networking','--no-proxy-server']});
  const specs=[{name:'desktop-1440',width:1440,height:900},{name:'retina-1280',width:1280,height:800,dpr:2},{name:'compact-1024',width:1024,height:768},{name:'tablet-768',width:768,height:1024},{name:'phone-390',width:390,height:844},{name:'effective-zoom-125',width:1152,height:720,dpr:2,equivalentDesktopZoom:1.25},{name:'effective-zoom-150',width:960,height:600,dpr:1.5,equivalentDesktopZoom:1.5},{name:'short-viewport',width:1024,height:420}];
  for (const spec of specs) await verifyViewport(browser,spec,origin);
  await verifyFreshOldCssCache(browser,origin);
  await verifyModeRecovery(browser,origin);
  assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);assert.equal(report.writeRequests,0);report.passed=true;
})().catch(e=>{report.fatal={stage,message:e.message,stack:e.stack};process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  for(const [name,value] of Object.entries(priorTemp))if(value===undefined)delete process.env[name];else process.env[name]=value;
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(temporaryRoot));fs.rmSync(directory,{recursive:true,force:true});
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,errors:report.errors,webkitAvailable:report.webkitAvailable,fatal:report.fatal,reportPath}));
});

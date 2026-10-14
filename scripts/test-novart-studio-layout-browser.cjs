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
let server, browser, stage = 'fixture';
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
  if (url.pathname === '/studio') {res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(shell());}
  if (url.pathname === '/studio/state') return json(res,{revision:0,profile:{nickname:'交互检查',density:'comfortable',motion:'reduce'},brand:{name:context.workspaces[0].name,colors:['#7C5CFF','#202028','#F6F4FC'],font:'sans',notes:''},favorites:[]});
  if (url.pathname === '/studio/project-library') return json(res,{projects:[project]});
  if (url.pathname === '/workflow/assets') return json(res,{assets:[]});
  if (url.pathname === '/api/workspaces') return json(res,{workspaces:context.workspaces});
  if (url.pathname === '/api/workbench/session') return json(res,{...context,activeWorkspaceId:context.workspaceId});
  if (url.pathname.endsWith('/notifications')) return json(res,{items:Array.from({length:12},(_,i)=>({id:'layout-notice-'+i,kind:'STUDIO_GENERATION',status:'SUCCEEDED',title:'通知 '+i,createdAt:'2026-10-13T08:00:00Z',href:'/canvas?workspaceId='+context.workspaceId+'&projectId='+project.projectId+'&requestId=layout-task-'+i}))});
  if (url.pathname.endsWith('/studio-layer-activity')) return json(res,{requests:Array.from({length:12},(_,i)=>({requestId:'layout-task-'+i,projectId:project.projectId,status:'RUNNING',createdAt:'2026-10-13T08:00:00Z',expiresAt:'2026-10-14T08:00:00Z',layerCount:4}))});
  if (url.pathname === '/canvas') {res.writeHead(307,{Location:'/studio-editor'+url.search});return res.end();}
  if (url.pathname === '/studio-editor') {res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(`<!doctype html><html data-nv-studio-canvas-ready="true"><head><meta charset="utf-8"></head><body style="margin:0;height:100vh;background:#fafafc"><div data-testid="owned-editor">布局用 iframe 协议测试件</div><script>const projectId=${JSON.stringify(project.projectId)};parent.postMessage({type:'nv-studio',action:'ready',projectId},location.origin);</script></body></html>`);}
  if (url.pathname === '/favicon.ico') {res.writeHead(204);return res.end();}
  const production = {
    '/novart-product-bootstrap.js':'deploy/novart/studio/novart-product-bootstrap.js',
    '/novart-product-task-inbox.js':'deploy/novart/studio/novart-product-task-inbox.js',
    '/home-start-studio.css':'previews/novart-workbench/harness/home-start-studio.css',
  };
  const file = production[url.pathname] ? path.join(repo,production[url.pathname]) : path.join(exported,url.pathname.slice(1));
  if (path.relative(repo,file).startsWith('..') || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res,{error:'Unavailable isolated route'},404);
  const mime = {'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.html':'text/html'}[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'});return res.end(fs.readFileSync(file));
}
function check(name,details) {report.checks.push({name,status:'PASS',...details});}
async function measure(page,selectors) {
  return page.evaluate(selectors=>Object.fromEntries(selectors.map(selector=>{
    const node=document.querySelector(selector),rect=node?.getBoundingClientRect(),style=node&&getComputedStyle(node);
    return [selector,rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom,display:style.display,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth}:null];
  })),selectors);
}
async function verifyViewport(browser,spec,origin) {
  stage = spec.name;
  const ctx = await browser.newContext({viewport:{width:spec.width,height:spec.height},deviceScaleFactor:spec.dpr || 1,locale:'zh-CN',reducedMotion:'reduce',serviceWorkers:'block'});
  await ctx.route('**/*',route=>{if(new URL(route.request().url()).origin !== origin){report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
  const page = await ctx.newPage();page.setDefaultTimeout(9000);page.on('pageerror',e=>report.errors.push({stage:spec.name,message:e.message}));
  try {
    await page.goto(origin+'/studio?workspaceId='+context.workspaceId+'#/home');
    await page.waitForFunction(()=>window.NovartStudio?.snapshot().stateLoaded && window.NovartStudio?.snapshot().projectCount===1 && !document.querySelector('.np-startup'));
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
    assert.match(await page.locator('.np-inbox-trigger').getAttribute('title'),/12条新提醒/);
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
    check(spec.name,{viewport:spec,dpr:spec.dpr||1,homeMeasurements:home,measurements:values,screenshot:shot});
  } finally {await ctx.close();}
}
(async()=>{
  assert.ok(fs.existsSync(path.join(exported,'studio.html')),'Build Studio export before this interaction regression');
  report.webkitAvailable = fs.existsSync(webkit.executablePath());
  report.webkitRun = false;
  server=http.createServer((req,res)=>{try{handle(req,res);}catch(e){report.errors.push({kind:'fixture',message:e.message});json(res,{error:'Fixture failed'},500);}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-background-networking','--no-proxy-server']});
  const specs=[{name:'desktop-1440',width:1440,height:900},{name:'retina-1280',width:1280,height:800,dpr:2},{name:'compact-1024',width:1024,height:768},{name:'tablet-768',width:768,height:1024},{name:'phone-390',width:390,height:844},{name:'effective-zoom-125',width:1152,height:720,dpr:2,equivalentDesktopZoom:1.25},{name:'short-viewport',width:1024,height:420}];
  for (const spec of specs) await verifyViewport(browser,spec,origin);
  assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);assert.equal(report.writeRequests,0);report.passed=true;
})().catch(e=>{report.fatal={stage,message:e.message,stack:e.stack};process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  for(const [name,value] of Object.entries(priorTemp))if(value===undefined)delete process.env[name];else process.env[name]=value;
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(temporaryRoot));fs.rmSync(directory,{recursive:true,force:true});
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,errors:report.errors,webkitAvailable:report.webkitAvailable,fatal:report.fatal,reportPath}));
});

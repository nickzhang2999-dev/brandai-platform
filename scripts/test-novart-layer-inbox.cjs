/* Actual inbox code: parser regressions + isolated headless browser/HTTP fixtures.
 * No real identity, database, provider, user browser, or editor mutation is used.
 * Browser clock is controlled only for polling/timeout lifecycle assertions. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http');
const {chromium}=require('playwright-core');
const repo=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(repo,'deploy/novart/studio/novart-product-task-inbox.js'),'utf8');
const fixture={workspaceId:'fixture-brand',userId:'fixture-actor',projectId:'fixture-project'};
const report={isolated:true,realBackend:false,realProvider:false,realAuthentication:false,realOwnedEditor:false,controlledBrowserClock:true,providerCalls:0,checks:[],externalRequests:[],errors:[],passed:false};
let stage='unit-parsers',browser,server,page,mode='normal';
const reportPath=process.env.NOVART_LAYER_INBOX_REPORT||path.join(repo,'.novart-build','reports','layer-inbox-'+Date.now()+'.json');
const temporaryRoot=path.join(repo,'.novart-build','temporary');fs.mkdirSync(temporaryRoot,{recursive:true});
const directory=fs.mkdtempSync(path.join(temporaryRoot,'layer-inbox-'));assert.equal(path.dirname(directory),temporaryRoot);
if(process.platform==='win32'){assert.equal(path.parse(directory).root.toLowerCase(),'d:\\');assert.equal(path.parse(path.resolve(reportPath)).root.toLowerCase(),'d:\\');}
fs.mkdirSync(path.dirname(reportPath),{recursive:true});
const previousTemp={TEMP:process.env.TEMP,TMP:process.env.TMP};process.env.TEMP=directory;process.env.TMP=directory;
const start='2026-10-12T08:00:00.000Z',finished='2026-10-12T08:02:30.000Z',expires='2026-10-12T09:00:00.000Z';
const parameters={STUDIO_UPLOAD:'taskId',STUDIO_GENERATION:'requestId',STUDIO_DECOMPOSITION:'layerRequestId'};
function notification(kind,id,status='SUCCEEDED'){return{id:'notice-'+kind+'-'+id,kind,status,title:kind==='STUDIO_DECOMPOSITION'?'分层任务终态':'既有任务',createdAt:finished,href:'/canvas?'+new URLSearchParams({workspaceId:fixture.workspaceId,projectId:fixture.projectId,[parameters[kind]]:id})};}
function copywritingNotification(id,status='SUCCEEDED'){return{id:'copywriting:'+id,kind:'STUDIO_COPYWRITING',status,title:'文案任务',createdAt:finished,href:'/canvas?'+new URLSearchParams({workspaceId:fixture.workspaceId,projectId:fixture.projectId})};}
function activity(requestId,status){return{requestId,projectId:fixture.projectId,status,createdAt:start,expiresAt:expires,layerCount:4};}
let terminal=[notification('STUDIO_UPLOAD','upload'),notification('STUDIO_GENERATION','generation'),notification('STUDIO_DECOMPOSITION','duplicate','FAILED')];
let live=[activity('pending','PENDING'),activity('running','RUNNING'),activity('success','SUCCEEDED'),activity('duplicate','RUNNING')];
const reads=[],held=new Set();let cancelled=0;
function check(name,detail={}){report.checks.push({name,status:'PASS',...detail});}
function json(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function settled(predicate){const deadline=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<deadline,'Fixture state did not settle');await new Promise(resolve=>setTimeout(resolve,20));}}
function parserFixture(){
  const window={__NOVART_PRODUCT__:{workspaceId:fixture.workspaceId,user:{id:fixture.userId}},addEventListener(){}};
  const marker='  window.NovartProductTaskInbox = Object.freeze';assert.ok(source.includes(marker));
  vm.runInNewContext(source.replace(marker,'  window.__fixtureParsers = {parse,parseActivity,mergeItems,elapsedText};\n'+marker),{window,location:{search:'',origin:'https://fixture.invalid'},URL,URLSearchParams,Date,Error,Number,Set,Map,AbortController});
  return window.__fixtureParsers;
}
function handle(req,res){
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/inbox.js'){res.setHeader('Content-Type','application/javascript');return res.end(source);}
  if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
  if(url.pathname==='/canvas'){
    assert.equal(req.method,'GET');assert.equal(url.searchParams.get('workspaceId'),fixture.workspaceId);assert.equal(url.searchParams.get('projectId'),fixture.projectId);
    res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><html><body><p data-testid="copywriting-project-fixture">文案项目导航夹具，不执行编辑或模型调用</p></body></html>');
  }
  if(url.pathname==='/studio'){
    res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><div class="ns-sidebar-bottom" style="position:fixed;bottom:20px;left:12px;width:170px"></div><div class="ns-frame-slot" data-active="true"><iframe data-testid="studio-canvas-frame" data-project-id="${fixture.projectId}" data-ready="true" src="/owned-frame-fixture" style="position:absolute;left:200px;top:20px;width:600px;height:300px"></iframe></div><script>window.__NOVART_PRODUCT__=${JSON.stringify({workspaceId:fixture.workspaceId,user:{id:fixture.userId}})};</script><script src="/inbox.js"></script><script>NovartProductTaskInbox.start();</script></body></html>`);
  }
  if(url.pathname==='/owned-frame-fixture'){
    res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(`<!doctype html><html data-nv-studio-canvas-ready="true"><body><div data-testid="owned-editor">合成 Owned frame，只记录打开任务，不执行编辑</div><script>window.received=[];addEventListener('message',e=>{if(e.origin===location.origin&&e.source===parent&&e.data?.type==='novart-product-task-open')received.push(e.data);});</script></body></html>`);
  }
  reads.push({path:url.pathname,method:req.method,user:req.headers['x-novart-user']});
  assert.equal(req.method,'GET','Inbox cannot submit a provider or editor mutation');assert.equal(req.headers['x-novart-user'],fixture.userId);
  if(url.pathname===`/api/workspaces/${fixture.workspaceId}/notifications`){assert.equal(url.searchParams.get('scope'),'studio');return json(res,{items:terminal});}
  assert.equal(url.pathname,`/api/workspaces/${fixture.workspaceId}/studio-layer-activity`);
  if(mode==='denied')return json(res,{error:'Fixture actor changed'},409);
  if(mode==='malformed')return json(res,{requests:[{...live[0],status:'INVENTED'}]});
  if(mode==='hang'){held.add(res);res.on('close',()=>{held.delete(res);cancelled++;});return;}
  return json(res,{requests:live});
}
async function ready(){await page.waitForFunction(()=>document.querySelector('[data-action="refresh"]')?.disabled===false);}
async function openPanel(){const trigger=page.getByTestId('product-task-inbox-trigger');if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();await ready();}
async function refresh(){const before=reads.length;await page.locator('[data-action="refresh"]').click();await settled(()=>reads.length>=before+2);await ready();}

(async()=>{
  const parsers=parserFixture();
  const parsed=parsers.parse({items:terminal}), activities=parsers.parseActivity({requests:live}), merged=parsers.mergeItems(activities,parsed);
  assert.equal(merged.length,6);assert.equal(merged.find(item=>item.taskId==='duplicate').status,'FAILED');assert.equal(merged.find(item=>item.taskId==='duplicate').terminal,true);check('terminal-overrides-live-and-deduplicates-kind-task-id');
  const distinct=parsers.mergeItems([],parsers.parse({items:[notification('STUDIO_UPLOAD','same'),notification('STUDIO_GENERATION','same'),notification('STUDIO_DECOMPOSITION','same')]}));assert.equal(distinct.length,3);check('same-id-different-kind-does-not-collide');
  const canonical=parsers.parse({items:[{...notification('STUDIO_DECOMPOSITION','one'),href:notification('STUDIO_DECOMPOSITION','one').href+'&extra=ignored'}]})[0];assert.ok(canonical.href.includes('layerRequestId=one'));assert.ok(!canonical.href.includes('extra'));check('layer-link-is-canonical-same-origin-workspace');
  for(const suffix of ['&requestId=other','&taskId=other','&layerRequestId=second','&workspaceId=other','#foreign'])assert.throws(()=>parsers.parse({items:[{...notification('STUDIO_DECOMPOSITION','one'),href:notification('STUDIO_DECOMPOSITION','one').href+suffix}]}));
  assert.throws(()=>parsers.parse({items:[{...notification('STUDIO_DECOMPOSITION','one'),href:'https://other.invalid/canvas?workspaceId=fixture-brand&projectId=fixture-project&layerRequestId=one'}]}));check('foreign-or-ambiguous-task-links-rejected');
  for(const invalid of [{...live[0],status:'UNKNOWN'},{...live[0],createdAt:0},{...live[0],expiresAt:'bad'},{...live[0],layerCount:-1},{...live[0],requestId:'bad/id'}])assert.throws(()=>parsers.parseActivity({requests:[invalid]}));assert.throws(()=>parsers.parseActivity({requests:[live[0],live[0]]}));check('malformed-activity-fails-closed');
  assert.match(parsers.elapsedText(merged.find(item=>item.taskId==='duplicate'),Date.parse(finished)),/2分30秒/);assert.equal(parsers.elapsedText(activities.find(item=>item.status==='SUCCEEDED')),'用时待任务信息更新');assert.equal(parsers.elapsedText(parsed[0]),'');assert.match(parsers.elapsedText(activities[0],Date.parse(start)-10000),/0秒/);check('elapsed-time-only-uses-server-timestamps-without-fake-progress');
  const copywriting=copywritingNotification('copywriting-one'),copywritingParsed=parsers.parse({items:[copywriting,copywritingNotification('copywriting-failed','FAILED')]});
  assert.equal(copywritingParsed.length,2);assert.equal(copywritingParsed[0].key,'STUDIO_COPYWRITING:copywriting-one');assert.equal(copywritingParsed[0].projectId,fixture.projectId);assert.equal(copywritingParsed[0].title,'文案已生成');assert.equal(copywritingParsed[1].title,'文案生成未完成');
  for(const suffix of ['&workspaceId=other','&projectId=other','&taskId=other','#foreign'])assert.throws(()=>parsers.parse({items:[{...copywriting,href:copywriting.href+suffix}]}));
  for(const href of ['https://foreign.invalid'+copywriting.href,'/studio?workspaceId='+fixture.workspaceId+'&projectId='+fixture.projectId,'/canvas?workspaceId=other&projectId='+fixture.projectId])assert.throws(()=>parsers.parse({items:[{...copywriting,href}]}));
  for(const invalid of [{...copywriting,id:'other:task'},{...copywriting,id:'copywriting:bad/id'},{...copywriting,status:'PENDING'},{...copywriting,createdAt:0}])assert.throws(()=>parsers.parse({items:[invalid]}));
  assert.throws(()=>parsers.parse({items:[copywriting,copywriting]}));check('copywriting-terminal-receipts-validate-identity-status-and-scoped-links');
  const mixed=parsers.parse({items:[copywriting,{kind:'OTHER_PRODUCT_WORKFLOW'},terminal[0]]});assert.equal(mixed.length,2);assert.equal(mixed[1].kind,'STUDIO_UPLOAD');
  assert.throws(()=>parsers.parse({items:[null]}));assert.throws(()=>parsers.parse({items:[{kind:'STUDIO_UPLOAD'}]}));check('unsupported-workflows-do-not-hide-supported-task-receipts');

  stage='browser-start';server=http.createServer((req,res)=>{try{handle(req,res);}catch(error){report.errors.push({kind:'fixture',message:error.message});json(res,{error:'Fixture validation failed'},500);}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.NOVART_CHROMIUM_EXECUTABLE?{executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE}:{}),args:['--disable-background-networking'],env:{...process.env,TEMP:directory,TMP:directory}});
  const context=await browser.newContext({viewport:{width:1100,height:800},serviceWorkers:'block'});await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin){report.externalRequests.push(url.hostname);return route.abort();}return route.continue();});await context.routeWebSocket('**/*',route=>{report.externalRequests.push('websocket');route.close();});
  page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',error=>report.errors.push({kind:'page',message:error.message}));await page.clock.install({time:new Date('2026-10-12T08:03:00Z')});await page.goto(origin+'/studio?workspaceId='+fixture.workspaceId+'#/brand');await ready();await page.clock.pauseAt(new Date('2026-10-12T08:03:10Z'));await openPanel();
  stage='four-statuses-and-cross-page-badge';for(const status of ['PENDING','RUNNING','SUCCEEDED','FAILED'])assert.ok(await page.locator(`.np-inbox-row[data-status="${status}"]`).count()>0);assert.equal(await page.locator('.np-inbox-row[data-task-id="duplicate"]').count(),1);assert.equal(await page.locator('.np-inbox-row[data-task-id="duplicate"]').getAttribute('data-status'),'FAILED');assert.equal(await page.getByTestId('product-task-inbox-trigger').getAttribute('data-active-count'),'2');assert.equal(await page.locator('.np-inbox-count').textContent(),'2');assert.match(await page.getByTestId('product-task-inbox-trigger').getAttribute('title'),/2项进行中/);assert.equal(await page.locator('[role="progressbar"]').count(),0);assert.match(await page.locator('.np-inbox-row[data-task-id="duplicate"]').textContent(),/提交至结果更新用时 2分30秒/);check('browser-shows-four-authoritative-statuses-and-active-badge-on-brand-page');await page.screenshot({path:reportPath.replace(/\.json$/i,'')+'-states.png'});

  stage='poll-every-twenty-seconds';live[0].status='RUNNING';terminal.push(notification('STUDIO_DECOMPOSITION','running','SUCCEEDED'));const beforePoll=reads.length;await page.clock.fastForward(19900);assert.equal(reads.length,beforePoll);await page.clock.fastForward(101);await settled(()=>reads.length>=beforePoll+2);await ready();assert.equal(await page.locator('.np-inbox-row[data-task-id="pending"]').getAttribute('data-status'),'RUNNING');assert.equal(await page.locator('.np-inbox-row[data-task-id="running"]').getAttribute('data-status'),'SUCCEEDED');assert.equal(await page.getByTestId('product-task-inbox-trigger').getAttribute('data-active-count'),'1');check('twenty-second-read-poll-updates-status-and-terminal-wins');

  stage='owned-layer-handoff';await page.locator('.np-inbox-row[data-task-id="running"]').getByRole('button',{name:'返回项目',exact:true}).click();const frame=page.frames().find(candidate=>candidate.url().endsWith('/owned-frame-fixture'));assert.ok(frame);let command;await page.waitForFunction(()=>document.querySelector('iframe').contentWindow.received.length===1);command=await frame.evaluate(()=>received[0]);assert.equal(command.kind,'STUDIO_DECOMPOSITION');assert.equal(command.taskId,'running');assert.equal(command.workspaceId,fixture.workspaceId);assert.equal(command.userId,fixture.userId);assert.ok(command.token);assert.equal(await frame.evaluate(()=>!!window.NovartProductMaterials||!!window.NovartProductGeneration),false);
  await page.evaluate(command=>{const child=document.querySelector('iframe').contentWindow;const reply={...command,type:'novart-product-task-opened',ok:true};for(const [origin,source,data] of [[location.origin,window,reply],['https://foreign.invalid',child,reply],[location.origin,child,{...reply,token:'wrong'}],[location.origin,child,{...reply,userId:'other'}],[location.origin,child,{...reply,kind:'STUDIO_UPLOAD'}]])dispatchEvent(new MessageEvent('message',{origin,source,data}));},command);assert.equal(await page.getByTestId('product-task-inbox').isVisible(),true);
  await frame.evaluate(command=>parent.postMessage({...command,type:'novart-product-task-opened',ok:true},location.origin),command);await page.getByTestId('product-task-inbox').waitFor({state:'hidden'});assert.equal((await frame.evaluate(()=>received)).length,1);check('layer-handoff-uses-owned-frame-and-rejects-forged-receipts-without-adapters');

  stage='copywriting-project-navigation';terminal.push(copywriting,{kind:'OTHER_PRODUCT_WORKFLOW'});await openPanel();
  assert.equal(await page.locator('.np-inbox-row[data-kind="STUDIO_COPYWRITING"]').count(),1);assert.equal(await page.locator('.np-inbox-status').textContent(),'');
  const originalUrl=page.url(),beforeCopywritingMessages=await frame.evaluate(()=>received.length);
  const popupPromise=page.waitForEvent('popup');await page.locator('.np-inbox-row[data-kind="STUDIO_COPYWRITING"]').getByRole('button',{name:'查看文案记录',exact:true}).click();
  const popup=await popupPromise;await popup.waitForLoadState('domcontentloaded');assert.equal(new URL(popup.url()).pathname,'/canvas');assert.equal(new URL(popup.url()).searchParams.get('workspaceId'),fixture.workspaceId);assert.equal(new URL(popup.url()).searchParams.get('projectId'),fixture.projectId);
  assert.equal(await popup.getByTestId('copywriting-project-fixture').count(),1);assert.equal(await popup.evaluate(()=>window.opener),null);assert.equal(page.url(),originalUrl);assert.equal(await frame.evaluate(()=>received.length),beforeCopywritingMessages);await popup.close();await ready();
  check('copywriting-opens-scoped-project-without-disrupting-current-canvas-or-handoff');

  stage='bounded-request-timeout';await openPanel();mode='hang';const beforeHang=reads.length;await page.locator('[data-action="refresh"]').click();await settled(()=>reads.length>=beforeHang+2&&held.size===1);const beforeAbort=cancelled;await page.clock.fastForward(12001);await settled(()=>cancelled>beforeAbort);await ready();assert.match(await page.locator('.np-inbox-status').textContent(),/部分任务暂未更新/);assert.equal(await page.locator('.np-inbox-row[data-task-id="running"]').getAttribute('data-status'),'SUCCEEDED');check('each-read-times-out-at-twelve-seconds-and-keeps-known-receipts');
  stage='rapid-visibility-cancellation';const beforeRapid=reads.length;await page.locator('[data-action="refresh"]').click();await settled(()=>reads.length>=beforeRapid+2&&held.size===1);const rapidAbort=cancelled;mode='normal';await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.fixtureVisibility||'visible'});window.fixtureVisibility='hidden';document.dispatchEvent(new Event('visibilitychange'));window.fixtureVisibility='visible';document.dispatchEvent(new Event('visibilitychange'));});await settled(()=>cancelled>rapidAbort);await ready();const beforeResume=reads.length;await page.clock.fastForward(1);await settled(()=>reads.length>=beforeResume+2);await ready();check('rapid-hidden-visible-transition-resumes-after-abort');
  stage='pagehide-cancellation';mode='hang';const beforeHide=reads.length;await page.locator('[data-action="refresh"]').click();await settled(()=>reads.length>=beforeHide+2&&held.size===1);const pendingAbort=cancelled;await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')));await settled(()=>cancelled>pendingAbort);const hiddenReads=reads.length;await page.clock.fastForward(60000);assert.equal(reads.length,hiddenReads);check('pagehide-aborts-inflight-fetch-and-cancels-future-polls');
  mode='normal';await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await settled(()=>reads.length>=hiddenReads+2);await ready();check('bfcache-pageshow-resumes-bounded-read-only-polling');
  stage='source-failure-is-visible';mode='malformed';await refresh();assert.match(await page.locator('.np-inbox-status').textContent(),/暂未更新/);assert.equal(await page.locator('.np-inbox-row[data-task-id="running"]').getAttribute('data-status'),'SUCCEEDED');check('invalid-live-response-preserves-known-data-with-visible-warning');
  stage='server-actor-denial';mode='denied';await page.locator('[data-action="refresh"]').click();await page.waitForFunction(()=>document.querySelector('.np-inbox-status').textContent.includes('权限已变化'));assert.equal(await page.locator('.np-inbox-row').count(),0);assert.match(await page.locator('.np-inbox-status').textContent(),/权限已变化/);const deniedReads=reads.length;await page.clock.fastForward(60000);assert.equal(reads.length,deniedReads);check('server-actor-denial-clears-items-and-stops-polling');
  stage='immutable-local-actor-boundary';mode='normal';await page.reload();await ready();await openPanel();assert.ok(await page.locator('.np-inbox-row').count()>0);const beforeIdentity=reads.length;await page.evaluate(()=>{window.__NOVART_PRODUCT__.user.id='fixture-new-actor';dispatchEvent(new Event('focus'));});await page.waitForFunction(()=>document.querySelector('.np-inbox-status').textContent.includes('权限已变化'));assert.equal(await page.locator('.np-inbox-row').count(),0);assert.equal(reads.length,beforeIdentity);check('mutated-account-context-cannot-reuse-old-user-workspace-cache');
  assert.ok(reads.every(item=>item.method==='GET'&&item.user===fixture.userId));assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.readRequests=reads.length;report.writeRequests=0;report.passed=true;
})().catch(async error=>{report.checks.push({name:stage,status:'FAIL'});report.fatal={stage,name:error.name,message:String(error.message).slice(0,800),stack:String(error.stack).slice(0,1200)};process.exitCode=1;try{if(page)await page.screenshot({path:reportPath.replace(/\.json$/i,'')+'-failure.png'});}catch{}}).finally(async()=>{
  try{await browser?.close();for(const res of held)res.destroy();if(server)await new Promise(resolve=>server.close(resolve));}finally{
    fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,reportPath}));
    for(const [key,value] of Object.entries(previousTemp))if(value===undefined)delete process.env[key];else process.env[key]=value;
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(temporaryRoot));fs.rmSync(directory,{recursive:true,force:true});
  }
});

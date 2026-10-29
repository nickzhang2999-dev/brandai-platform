// Isolated UI interaction fixture, not provider/content acceptance. No external network or actual identity.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'deploy/novart/studio/novart-product-task-inbox.js'),'utf8');
const user='activity-user',workspace='activity-workspace',base=Date.now(),iso=n=>new Date(base+n).toISOString();
let phase='pending',browser,server;const requests=[],checks=[],errors=[];
const item={id:'chat-one',conversationId:'conversation-one',status:'PENDING',createdAt:iso(0),updatedAt:iso(0),expiresAt:iso(360000),expired:false};
const report=path.join(root,'.novart-build/reports/inspiration-activity-browser.json');
const json=(res,value)=>{res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value));};
(async()=>{
  const win={__NOVART_PRODUCT__:{workspaceId:workspace,user:{id:user}},addEventListener(){}};
  vm.runInNewContext(source.replace('  window.NovartProductTaskInbox = Object.freeze','  window.testParsers={parse,parseInspiration,mergeItems};\n  window.NovartProductTaskInbox = Object.freeze'),{window:win,location:{search:'',origin:'http://fixture.invalid'},URL,URLSearchParams,Date,Error,Number,Set,Map,AbortController});
  const parsers=win.testParsers;assert.equal(parsers.parseInspiration({enabled:true,items:[item]})[0].status,'PENDING');
  for(const bad of [{...item,id:'bad/id'},{...item,conversationId:'bad&other'},{...item,expiresAt:'bad'},{...item,status:'UNKNOWN'}])assert.throws(()=>parsers.parseInspiration({enabled:true,items:[bad]}));checks.push('strict metadata and conversation identifier parsing');
  const terminal={id:'inspiration-chat:chat-one',kind:'INSPIRATION_CHAT',status:'SUCCEEDED',title:'ignored title',createdAt:iso(20000),href:`/inspiration?workspaceId=${workspace}&conversationId=conversation-one`};
  const copywriting={id:'copywriting:copy-one',kind:'STUDIO_COPYWRITING',status:'SUCCEEDED',title:'文案已生成',createdAt:iso(20000),href:`/canvas?workspaceId=${workspace}&projectId=project-one`};
  const existing={id:'notice-generation',kind:'STUDIO_GENERATION',status:'SUCCEEDED',title:'图片已生成',createdAt:iso(20000),href:`/canvas?workspaceId=${workspace}&projectId=project-one&requestId=existing-one`};
  const unsupported={id:'workflow-one',kind:'STUDIO_CONVERSATION',status:'SUCCEEDED',title:'其他工作流',createdAt:iso(20000),href:'https://untrusted.invalid/ignored'};
  assert.equal(parsers.parse({items:[terminal]})[0].key,'INSPIRATION_CHAT:chat-one');
  for(const href of ['https://evil.invalid/inspiration',`/inspiration?workspaceId=other&conversationId=conversation-one`,`/inspiration?workspaceId=${workspace}&conversationId=conversation-one&workspaceId=other`])assert.throws(()=>parsers.parse({items:[{...terminal,href}]}));checks.push('terminal links reject foreign origin/workspace and duplicate query');
  assert.equal(parsers.parse({items:[copywriting,terminal,existing,unsupported]}).length,3);
  for(const href of [`/canvas?workspaceId=other&projectId=project-one`,`/canvas?workspaceId=${workspace}&projectId=project-one&projectId=another`,'https://evil.invalid/canvas',`/canvas?workspaceId=${workspace}&projectId=project-one&taskId=other`])assert.throws(()=>parsers.parse({items:[{...copywriting,href}]}));checks.push('mixed known kinds survive unsupported workflow and copywriting links stay scoped');
  server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/inbox.js'){res.writeHead(200,{'content-type':'application/javascript'}).end(source);return;}
    if(url.pathname==='/favicon.ico'){res.writeHead(204).end();return;}
    if(url.pathname==='/studio'){res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end(`<!doctype html><div class="ns-sidebar-bottom" style="position:fixed;bottom:20px;left:10px;width:180px"></div><script>window.__NOVART_PRODUCT__=${JSON.stringify({workspaceId:workspace,user:{id:user}})};window.open=(href)=>{window.opened=href;return null;};</script><script src="/inbox.js"></script><script>NovartProductTaskInbox.start();</script>`);return;}
    requests.push({method:req.method,path:url.pathname,user:req.headers['x-novart-user']});
    if(url.pathname.endsWith('/notifications'))return json(res,{items:phase==='mixed'?[copywriting,terminal,existing,unsupported]:phase==='terminal'?[terminal]:[]});
    if(url.pathname.endsWith('/studio-layer-activity'))return json(res,{requests:[]});
    if(url.pathname.endsWith('/inspiration/activity'))return json(res,{enabled:true,items:[{...item,status:phase==='running'?'RUNNING':phase==='terminal'?'SUCCEEDED':'PENDING',updatedAt:phase==='terminal'?iso(20000):item.updatedAt}]});
    res.writeHead(404).end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined)});
  const context=await browser.newContext({viewport:{width:1000,height:700}});await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.clock.install({time:new Date(base+10000)});await page.goto(origin+'/studio?workspaceId='+workspace+'#/brand');
  await page.waitForFunction(()=>document.querySelector('[data-testid="product-task-inbox-trigger"]')?.dataset.activeCount==='1');await page.getByTestId('product-task-inbox-trigger').click();
  await page.waitForFunction(()=>document.querySelector('.np-inbox-row')?.dataset.status==='PENDING');assert.match(await page.locator('.np-inbox-row').textContent(),/排队中/);checks.push('pending inspiration task visible on studio brand page');
  phase='running';await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.np-inbox-row')?.dataset.status==='RUNNING');assert.match(await page.locator('.np-inbox-row').textContent(),/处理中/);checks.push('running phase and elapsed time update from server metadata');
  await page.evaluate(()=>location.hash='#/resources');assert.equal(await page.locator('.np-inbox-row').count(),1);await page.getByRole('button',{name:'查看灵感对话'}).click();assert.equal(await page.evaluate(()=>window.opened),terminal.href);assert.ok(page.url().includes('#/resources'));checks.push('cross-page task persists and opens conversation without discarding studio draft');
  phase='terminal';await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.np-inbox-row')?.dataset.status==='SUCCEEDED');assert.equal(await page.locator('.np-inbox-row').count(),1);assert.equal(await page.getByTestId('product-task-inbox-trigger').getAttribute('data-active-count'),'0');checks.push('terminal notification merges without duplicate activity item');
  phase='mixed';await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.np-inbox-row').length===3);
  for(const kind of ['STUDIO_COPYWRITING','INSPIRATION_CHAT','STUDIO_GENERATION'])assert.equal(await page.locator(`.np-inbox-row[data-kind="${kind}"]`).count(),1);
  assert.equal(await page.locator('.np-inbox-row[data-kind="STUDIO_CONVERSATION"]').count(),0);assert.equal(await page.locator('.np-inbox-status').textContent(),'');
  await page.getByRole('button',{name:'查看文案记录'}).click();assert.equal(await page.evaluate(()=>window.opened),copywriting.href);assert.ok(page.url().includes('#/resources'));checks.push('actual browser renders copywriting inspiration and canvas mixed feed while skipping unsupported kind');
  phase='running';await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.np-inbox-row')?.dataset.status==='RUNNING');await page.clock.fastForward(360000);await page.waitForFunction(()=>document.querySelector('.np-inbox-row')?.textContent.includes('已超时'));checks.push('stale pending metadata gives six-minute timeout exit without retrying');
  assert.ok(requests.every(r=>r.method==='GET'&&r.user===user));assert.equal(errors.length,0);fs.mkdirSync(path.dirname(report),{recursive:true});await page.screenshot({path:report.replace('.json','.png')});
})().catch(error=>{errors.push(error.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.mkdirSync(path.dirname(report),{recursive:true});const result={synthetic:true,realProvider:false,paidCalls:0,checks,errors,passed:!errors.length};fs.writeFileSync(report,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,report}));});

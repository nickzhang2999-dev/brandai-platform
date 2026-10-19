'use strict';
// Real homepage handoff JavaScript, DOM events and IndexedDB in local Chromium.
// The editor and HTTP receipts are synthetic: no auth, SQL or provider evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {chromium} = require('playwright-core');
const root = path.resolve(__dirname,'..');
const reportPath = path.join(root,'.novart-build/reports/home-creation-browser.json');
const report = {scope:'Actual homepage handoff module with real DOM/IndexedDB; synthetic host/editor/HTTP receipts',realBackend:false,realOwnedEditor:false,providerCalls:0,checks:[],errors:[],externalRequests:[],passed:false};
let server,browser,page,stage='setup',dropCreationAck=false,rejectSave=false;
const creates=new Map(),accepts=new Map(),uploads=new Map(),events=[];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9YoAAAAASUVORK5CYII=','base64');
const json=(res,value)=>{res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function body(req){const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks).toString('utf8');}
function shell(){
  const html=fs.readFileSync(path.join(root,'apps/web/studio-shell/studio.html'),'utf8');
  const form=html.match(/<form id="ns-composer"[\s\S]*?<\/form>/)?.[0];assert(form);
  return `<!doctype html><html><meta charset="utf-8"><style>[hidden]{display:none!important}#hs-handoff{background:white;padding:20px}iframe{width:600px;height:180px}</style><body>${form}<button id="ns-create-blank">打开空白画布</button><p id="ns-create-status"></p><p id="hs-draft-note"></p><div id="hs-recovery" hidden></div><div id="hs-handoff" hidden></div><div id="ns-frames"><iframe id="editor" hidden></iframe></div><p id="notices"></p><script>window.__NOVART_PRODUCT__={workspaceId:'browser-workspace'};</script><script src="/home-start-attachments.js"></script><script>
    let active=false,entry=null;const $=id=>document.getElementById(id);
    const node=(tag,classes,text)=>{const n=document.createElement(tag);n.className=classes||'';n.textContent=text||'';return n;};
    const host={node,button:(text,classes,action)=>{const n=node('button',classes,text);n.type='button';n.onclick=action;return n;},notify:text=>{$('notices').textContent=text;},legacyBlocked:()=>false,composing:()=>false,
      async api(url,value){return (await fetch('/fixture/create',{method:'POST',body:JSON.stringify(value)})).json();},reloadProjects:async()=>{},project:id=>({projectId:id}),
      openProject(id){active=true;location.hash='/workspace/'+id;entry={id,ready:false,frame:$('editor')};entry.frame.hidden=false;entry.frame.src='/fixture/editor?projectId='+encodeURIComponent(id);},current:value=>active&&entry===value,goProjects(){active=false;},invalidateAssets(){},showRequirements(){},refreshImportedFrame(value){value.frame.src=value.frame.src;}};
    const home=window.testHome=createHomeStart(host);
    $('ns-composer').addEventListener('submit',event=>{event.preventDefault();void home.create();});
    $('ns-create-blank').onclick=()=>{$('notices').textContent='空白画布已打开';};
    addEventListener('message',event=>{if(event.source===entry?.frame.contentWindow&&event.origin===location.origin&&event.data.action==='ready'&&event.data.projectId===entry.id){entry.ready=true;void home.resume(entry);}});
  </script></body></html>`;
}
async function handle(req,res){
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(shell());}
  if(url.pathname==='/home-start-attachments.js'){res.setHeader('Content-Type','application/javascript');return res.end(fs.readFileSync(path.join(root,'deploy/novart/studio/novart-owned-home-start.js')));}
  if(url.pathname==='/fixture/create'){const input=JSON.parse(await body(req));events.push({action:'create',...input});if(!creates.has(input.requestId))creates.set(input.requestId,{projectId:'p-'+input.requestId});return json(res,creates.get(input.requestId));}
  if(url.pathname==='/studio/material-upload'){
    const raw=await body(req), mutationId=req.method==='POST'?raw.match(/name="mutationId"\r?\n\r?\n([^\r\n]+)/)?.[1]:url.searchParams.get('taskId')?.slice(5);
    assert(mutationId);const projectId=url.searchParams.get('projectId');const taskId='task-'+mutationId;
    const material={id:'material-'+mutationId,assetId:'asset-'+mutationId,assetSha256:'a'.repeat(64),kind:'image',mimeType:'image/png',fileName:'fixture.png',sizeBytes:png.length,width:1,height:1,url:'/api/workspaces/browser-workspace/assets/asset-'+mutationId+'/raw'};
    const receipt={taskId,projectId,mutationId,status:'SUCCEEDED',progress:100,expiresAt:new Date(Date.now()+360000).toISOString(),material};uploads.set(mutationId,receipt);events.push({action:'upload',mutationId});return json(res,receipt);
  }
  if(url.pathname==='/fixture/message'){
    const input=JSON.parse(await body(req));events.push(input);
    if(input.action==='start-creation'){if(!accepts.has(input.requestId))accepts.set(input.requestId,input);else assert.deepEqual(accepts.get(input.requestId),input);return json(res,{drop:dropCreationAck,status:'accepted'});}
    return json(res,{status:rejectSave?'failed':'saved',revision:1,error:rejectSave?'合成保存尚未确认':''});
  }
  if(url.pathname==='/fixture/editor'){
    const projectId=url.searchParams.get('projectId');res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.end(`<!doctype html><meta charset="utf-8"><p>合成编辑器回执测试件</p><script>const projectId=${JSON.stringify(projectId)};parent.postMessage({type:'nv-studio',action:'ready',projectId},location.origin);addEventListener('message',async event=>{const d=event.data;if(event.source!==parent||event.origin!==location.origin||d.projectId!==projectId||!['insert-material','start-creation'].includes(d.action))return;const r=await(await fetch('/fixture/message',{method:'POST',body:JSON.stringify(d)})).json();if(!r.drop)parent.postMessage({type:'nv-studio',action:d.action+'-result',projectId,requestId:d.requestId,status:r.status,revision:r.revision,error:r.error},location.origin);});</script>`);
  }
  if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}res.writeHead(404);res.end();
}
function check(name){report.checks.push(name);console.log('PASS '+name);}
async function fresh(base){if(page)await page.context().close();const context=await browser.newContext();page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));page.on('request',request=>{if(!request.url().startsWith(base)&&!request.url().startsWith('blob:')&&!request.url().startsWith('data:'))report.externalRequests.push(request.url());});await page.goto(base);await page.waitForFunction(()=>window.testHome?.snapshot().loaded);}
async function finished(){await page.waitForFunction(()=>!testHome.snapshot().submittedRequestId&&!testHome.snapshot().running.length);}
(async()=>{
  server=http.createServer((req,res)=>void handle(req,res).catch(error=>{report.errors.push(error.stack);res.writeHead(500);res.end();}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.NOVART_CHROMIUM_EXECUTABLE?{executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE}:{}),args:['--disable-dev-shm-usage']});
  stage='empty-and-long-input';await fresh(base);await page.getByRole('button',{name:'开始创作',exact:true}).click();assert.equal(creates.size,0);await page.getByRole('button',{name:'打开空白画布'}).click();assert.equal(accepts.size,0);check('empty-and-blank-actions-do-not-generate');
  const long='😀'.repeat(2001);await page.locator('#ns-home-brief').fill(long);await page.getByRole('button',{name:'开始创作',exact:true}).click();assert.equal(await page.locator('#ns-home-brief').inputValue(),long);assert.equal(creates.size,0);await page.getByText('创作需求最多 4000 个字符，完整草稿仍保留。请缩短后再开始。',{exact:true}).waitFor();check('over-limit-input-is-kept-whole-with-readable-error');
  stage='text-only';await page.locator('#ns-home-brief').fill('日落时分的海边场景');await page.locator('#ns-create').click();await finished();assert.equal(creates.size,1);assert.equal(accepts.size,1);assert.equal(uploads.size,0);assert.equal([...accepts.values()][0].text,'日落时分的海边场景');assert.equal(await page.locator('#ns-home-brief').inputValue(),'');check('explicit-text-start-gets-one-accepted-conversation');
  stage='images-save-before-creation';await fresh(base);const before=events.length;await page.locator('#ns-home-brief').fill('参考图片做海边海报');await page.locator('#hs-file-input').setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:png});await page.waitForFunction(()=>testHome.snapshot().attachmentCount===1&&!testHome.snapshot().recoveryPending);await page.locator('#ns-create').click();await finished();const trail=events.slice(before);assert.deepEqual(trail.map(item=>item.action),['create','upload','insert-material','start-creation']);assert.deepEqual(trail[3].referenceShapeIds,['shape:home-'+trail[2].requestId]);check('real-file-input-upload-and-save-ack-precede-first-creation');
  stage='image-only';await fresh(base);const count=accepts.size;await page.locator('#hs-file-input').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:png});await page.getByRole('button',{name:'放入画布',exact:true}).waitFor();await page.locator('#ns-create').click();await finished();assert.equal(accepts.size,count);check('image-only-start-does-not-invent-a-paid-prompt');
  stage='save-failure';await fresh(base);rejectSave=true;await page.locator('#ns-home-brief').fill('保存确认后才生成');await page.locator('#hs-file-input').setInputFiles({name:'recover.png',mimeType:'image/png',buffer:png});await page.locator('#ns-create').click();await page.locator('#hs-handoff[data-state="error"]').waitFor();const acceptedBefore=accepts.size;assert.equal(await page.evaluate(()=>testHome.snapshot().attachmentCount),1);assert(await page.evaluate(()=>Boolean(testHome.snapshot().submittedRequestId)));rejectSave=false;await page.getByRole('button',{name:'继续确认',exact:true}).click();await finished();assert.equal(accepts.size,acceptedBefore+1);check('rejected-save-keeps-input-and-reference-until-explicit-recovery');
  stage='lost-receipt-refresh';await fresh(base);dropCreationAck=true;await page.locator('#ns-home-brief').fill('丢回执之后还是同一次创作');const acceptedCount=accepts.size;await page.locator('#ns-create').click();await page.waitForFunction(()=>document.querySelector('#hs-handoff strong')?.textContent==='正在开始创作');await new Promise(resolve=>setTimeout(resolve,80));assert.equal(accepts.size,acceptedCount+1);const requestId=await page.evaluate(()=>testHome.snapshot().submittedRequestId);await page.reload();await page.waitForFunction(()=>testHome.snapshot().loaded);dropCreationAck=false;await page.locator('#ns-create').click();await finished();assert.equal(accepts.size,acceptedCount+1);assert.equal(events.filter(event=>event.action==='start-creation'&&event.requestId===requestId).length,2);check('refresh-after-lost-ack-replays-same-identity-once-with-no-second-acceptance');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);report.passed=true;
})().catch(error=>{report.fatal={stage,message:error.message,stack:error.stack};process.exitCode=1;}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,reportPath,fatal:report.fatal,errors:report.errors}));});

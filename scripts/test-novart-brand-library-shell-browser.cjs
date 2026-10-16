/* Production Studio shell/resources/transport, synthetic loopback persistence.
 * No real account, DB, storage, model, or user's browser is used. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {chromium}=require('playwright-core');
const repo=path.resolve(__dirname,'..'),exported=path.join(repo,'.novart-build/studio');
const reportPath=process.env.NOVART_BRAND_LIBRARY_SHELL_REPORT||path.join(repo,'.novart-build/reports/brand-library-shell-'+Date.now()+'.json');
fs.mkdirSync(path.dirname(reportPath),{recursive:true});
const report={isolated:true,realBackend:false,realProvider:false,realAuthentication:false,providerCalls:0,checks:[],errors:[],externalRequests:[],passed:false};
const actor={id:'brand-library-actor',name:'交互检查',email:''},ws={id:'brand-library-w',name:'品牌素材交互测试',role:'OWNER'};
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64'),sha=crypto.createHash('sha256').update(image).digest('hex');
const assets=new Map(),uploads=new Map();let workflowReads=0,projectCreates=0,libraryReads=0,uploadPosts=0,projects=[],server,browser,page,stage='start';
function material(id,name){return{id,assetId:id,assetSha256:sha,fileName:name,mimeType:'image/png',sizeBytes:image.length,width:1,height:1,kind:'image',url:`/api/workspaces/${ws.id}/assets/${id}/raw`};}
function asset(id,name){const m=material(id,name);const value={assetId:id,fileName:name,mimeType:m.mimeType,sizeBytes:m.sizeBytes,libraryKind:'MATERIAL',createdAt:'2026-10-14T00:00:00.000Z',url:m.url,material:m};assets.set(id,value);return value;}
asset('library-product','品牌产品.png');asset('library-package','包装参考.png');
const state={revision:0,profile:{nickname:'交互检查',density:'comfortable',motion:'reduce'},brand:{name:ws.name,colors:['#7C5CFF','#202028','#F6F4FC'],font:'sans',notes:''},favorites:[]};
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function body(req){const values=[];for await(const value of req)values.push(value);return Buffer.concat(values);}
function shell(){const context={workspaceId:ws.id,workspaces:[ws],user:actor};const html=fs.readFileSync(path.join(repo,'apps/web/studio-shell/studio.html'),'utf8').replace(/<script\b([^>]*)>/g,(_all,attrs)=>`<script type="application/x-novart"${attrs.replace(/\s+type=["'][^"']*["']/g,'')}>`);return html.replace('</head>',`<script id="novart-product-context" type="application/json">${JSON.stringify(context)}</script><script defer src="/novart-product-bootstrap.js"></script></head>`);}
async function handle(req,res){
 const url=new URL(req.url,'http://127.0.0.1'),prefix=`/api/workspaces/${ws.id}/studio-brand-materials`;
 if(url.pathname==='/studio'){res.setHeader('Content-Type','text/html');return res.end(shell());}
 if(url.pathname==='/studio/state')return json(res,state);
 if(url.pathname==='/studio/project-library')return json(res,{projects});
 if(url.pathname==='/compare/api/create'){projectCreates++;return json(res,{error:'Fixture must never create a project for uploads'},422);}
 if(url.pathname==='/api/workspaces')return json(res,[{...ws,ownerId:actor.id}]);
 if(url.pathname==='/api/workbench/session')return json(res,{user:actor,workspaces:[ws],activeWorkspaceId:ws.id});
 if(url.pathname===prefix){
  assert.equal(req.headers['x-novart-user'],actor.id);libraryReads++;assert.equal(url.searchParams.get('limit'),'24');
  const rows=[...assets.values()].filter(v=>v.fileName.includes(url.searchParams.get('search')||'')),offset=url.searchParams.has('cursor')?1:0;
  return json(res,{items:rows.slice(offset,offset+1),nextCursor:rows.length>offset+1?'next-fixture-page':null});
 }
 if(url.pathname===prefix+'/upload'){
  assert.equal(req.headers['x-novart-user'],actor.id);
  if(req.method==='GET')return json(res,{tasks:[...uploads.values()]});
  uploadPosts++;const form=await new Response(await body(req),{headers:{'Content-Type':req.headers['content-type']}}).formData();assert.deepEqual([...form.keys()].sort(),['file','mutationId']);
  const mutationId=form.get('mutationId');if(uploads.has(mutationId))return json(res,uploads.get(mutationId),202);
  const file=form.get('file'),id='library-upload-'+uploads.size,value=asset(id,file.name);
  const task={context:'brand-library',workspaceId:ws.id,taskId:'brand-task-'+uploads.size,mutationId,status:'SUCCEEDED',progress:100,expiresAt:new Date(Date.now()+360000).toISOString(),material:value.material};uploads.set(mutationId,task);return json(res,task,202);
 }
 if(url.pathname==='/workflow/assets'){workflowReads++;assert.equal(url.searchParams.get('projectId'),'actual-fixture-project');assert.equal(url.searchParams.get('workspaceId'),ws.id);return json(res,{assets:[{shapeId:'shape:project-image',assetSha256:sha,name:'项目图片',width:1,height:1,valid:true,mime:'image/png'}],issues:[]});}
 if(url.pathname.startsWith('/workflow/image/')||url.pathname.startsWith(`/api/workspaces/${ws.id}/assets/`)){res.setHeader('Content-Type','image/png');return res.end(image);}
 if(url.pathname.endsWith('/notifications'))return json(res,{items:[]});
 if(url.pathname.endsWith('/studio-layer-activity'))return json(res,{requests:[]});
 if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
 const production={'/novart-product-bootstrap.js':'deploy/novart/studio/novart-product-bootstrap.js','/novart-product-task-inbox.js':'deploy/novart/studio/novart-product-task-inbox.js','/home-start-studio.css':'apps/web/studio-shell/home-start-studio.css','/home-start-studio.js':'apps/web/studio-shell/home-start-studio.js','/home-start-attachments.js':'deploy/novart/studio/novart-owned-home-start.js'};
 const file=production[url.pathname]?path.join(repo,production[url.pathname]):path.join(exported,url.pathname.slice(1));
 if(path.relative(repo,file).startsWith('..')||!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,{error:'Unavailable fixture route'},404);
 res.writeHead(200,{'Content-Type':{'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.html':'text/html'}[path.extname(file)]||'application/octet-stream'});res.end(fs.readFileSync(file));
}
const check=async(name,fn)=>{await fn();report.checks.push(name);};
(async()=>{
 server=http.createServer((req,res)=>handle(req,res).catch(error=>{report.errors.push(error.message);json(res,{error:'Fixture failed'},500);}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe',args:['--disable-background-networking','--no-proxy-server']});
 const context=await browser.newContext({viewport:{width:1280,height:850},serviceWorkers:'block'});await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
 page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push(error.message));await page.goto(origin+`/studio?workspaceId=${ws.id}#/resources`);await page.waitForFunction(()=>window.NovartStudio?.snapshot().stateLoaded&&!document.querySelector('.np-startup'));
 await check('projectless brand assets appear without walking any project canvas',async()=>{await page.getByRole('button',{name:'预览 品牌产品.png'}).waitFor();assert.equal(workflowReads,0);assert.equal(projectCreates,0);assert.equal(await page.locator('#ns-resource-project').inputValue(),'');});
 await check('real pagination entry loads the next asset and preserves the first',async()=>{await page.getByRole('button',{name:'加载更多品牌素材',exact:true}).click();await page.getByRole('button',{name:'预览 包装参考.png'}).waitFor();assert.equal(await page.locator('#ns-assets .ns-asset-card').count(),2);assert.ok(libraryReads>=2);});
 await check('brand preview uses canonical asset URL, dimensions and no fake source project',async()=>{await page.getByRole('button',{name:'预览 包装参考.png'}).click();await page.waitForFunction(()=>document.querySelector('#ns-preview-image')?.naturalWidth===1);assert.equal(await page.locator('#ns-preview-source').isVisible(),false);assert.match(await page.locator('#ns-preview-meta').textContent(),/1 × 1 px/);await page.getByRole('button',{name:'关闭图片预览'}).click();});
 await check('brand search is server-backed and retains membership-scoped endpoint',async()=>{await page.getByRole('searchbox',{name:'搜索品牌素材'}).fill('包装');await page.getByRole('button',{name:'预览 包装参考.png'}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('#ns-assets .ns-asset-card').length===1&&document.querySelector('#ns-assets strong')?.textContent==='包装参考.png');});
 await check('upload without a project persists an explicit brand task, no project creation',async()=>{await page.locator('#ns-brand-upload-file').setInputFiles({name:'全局上传.png',mimeType:'image/png',buffer:image});await page.locator('#ns-brand-upload-status').filter({hasText:'图片已保存到品牌素材库'}).waitFor();assert.equal(uploads.size,1);assert.equal(projectCreates,0);assert.equal(workflowReads,0);assert.equal(uploadPosts,1);await page.getByRole('searchbox',{name:'搜索品牌素材'}).fill('全局上传');await page.getByRole('button',{name:'预览 全局上传.png'}).waitFor();});
 await check('reload retains brand asset and never resubmits upload or creates a fake project',async()=>{const before=uploadPosts;await page.reload();await page.getByRole('searchbox',{name:'搜索品牌素材'}).fill('全局上传');await page.getByRole('button',{name:'预览 全局上传.png'}).waitFor();assert.equal(uploadPosts,before);assert.equal(uploads.size,1);assert.equal(projectCreates,0);});
 await check('an explicit project filter still reads its original saved canvas assets',async()=>{projects=[{projectId:'actual-fixture-project',projectName:'已有项目',hasCanvas:true,updatedAt:new Date().toISOString(),archivedAt:null,archiveRevision:0}];await page.reload();await page.waitForFunction(()=>document.querySelector('#ns-resource-project')?.options.length===2);await page.getByRole('combobox',{name:'素材来源项目'}).selectOption('actual-fixture-project');await page.getByRole('button',{name:'预览 项目图片'}).waitFor();assert.ok(workflowReads>=1);assert.equal(projectCreates,0);});
 await check('phone brand library has no horizontal document overflow',async()=>{await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);});
 assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;
})().catch(error=>{report.fatal={stage,message:error.message,stack:error.stack};process.exitCode=1;}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,reportPath,fatal:report.fatal,errors:report.errors}));});

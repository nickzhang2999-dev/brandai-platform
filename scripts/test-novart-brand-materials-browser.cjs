/* Actual production React library drawer and pointer/keyboard interactions.
 * Local HTTP fixture only: no real authentication, DB, storage or provider.
 * This cannot be used as real generation/material-persistence acceptance. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto'), zlib = require('node:zlib');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');
const repo = path.resolve(__dirname, '..');
const temporaryRoot = path.join(repo, '.novart-build', 'temporary'); fs.mkdirSync(temporaryRoot,{recursive:true});
const directory = fs.mkdtempSync(path.join(temporaryRoot,'brand-materials-browser-'));
const esbuildPackage = fs.readdirSync(path.join(repo,'node_modules/.pnpm')).find(n=>n.startsWith('esbuild@0.28.'));
const esbuild = require(path.join(repo,'node_modules/.pnpm',esbuildPackage,'node_modules/esbuild'));
const report={isolated:true,realBackend:false,realProvider:false,realAuthentication:false,providerCalls:0,checks:[],errors:[],externalRequests:[]};
let server,browser,deny=false,invalidReceipt=false,failedVerification=false;
const entries = new Map(), uploadTasks = new Map(), links=[];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==','base64');
const hash=crypto.createHash('sha256').update(png).digest('hex');
const material=(id,fileName)=>({id,assetId:id,assetSha256:hash,fileName,mimeType:'image/png',sizeBytes:png.length,width:1,height:1,url:`/api/workspaces/w/assets/${id}/raw`,kind:'image'});
function entry(id,name,verified=true){const m=material(id,name);const e={assetId:id,fileName:name,mimeType:m.mimeType,sizeBytes:m.sizeBytes,libraryKind:'MATERIAL',createdAt:'2026-10-14T00:00:00.000Z',url:m.url,...(verified?{material:m}:{})};entries.set(id,e);return e;}
entry('a','品牌产品.png',false);entry('b','包装参考.png',true);
function json(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function bytes(req){const chunks=[];for await(const c of req)chunks.push(c);return Buffer.concat(chunks);}
async function handle(req,res){
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/app.js'||url.pathname==='/app.css'){res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript':'text/css');return res.end(fs.readFileSync(path.join(directory,url.pathname.slice(1))));}
  if(url.pathname==='/api/workspaces/w/studio-brand-materials/upload'){
    if(req.method==='GET')return json(res,{tasks:[...uploadTasks.values()]});
    const body=await bytes(req);const form=await new Response(body,{headers:{'Content-Type':req.headers['content-type']}}).formData();
    assert.equal(form.get('attachToProject'),null);assert.equal(form.get('projectId'),null);
    const mutationId=form.get('mutationId'),old=uploadTasks.get(mutationId);if(old)return json(res,old,202);
    const file=form.get('file'),id='upload-'+uploadTasks.size,e=entry(id,file.name);
    const task={taskId:'task-'+uploadTasks.size,context:'brand-library',workspaceId:'w',mutationId,status:'SUCCEEDED',progress:100,expiresAt:new Date(Date.now()+360000).toISOString(),material:e.material};
    uploadTasks.set(mutationId,task);return json(res,task,202);
  }
  if(url.pathname==='/api/workspaces/w/studio-brand-materials'){
    const all=[...entries.values()].filter(e=>e.fileName.includes(url.searchParams.get('search')||''));
    const offset=url.searchParams.has('cursor')?1:0;
    return json(res,{items:all.slice(offset,offset+1),nextCursor:all.length>offset+1?'page-two':null});
  }
  if(/^\/api\/workspaces\/w\/studio-brand-materials\/[^/]+$/.test(url.pathname)){
    const id=decodeURIComponent(url.pathname.split('/').at(-1)),e=entries.get(id);
    if(!e)return json(res,{error:'素材不存在'},404);
    if(deny)return json(res,{error:'权限不足，未加入项目'},403);
    const operation=req.method==='POST'?JSON.parse((await bytes(req)).toString()):{operation:'verify'};
    if(operation.operation==='verify')return json(res,failedVerification?{assetId:id,status:'FAILED',error:'实际图片内容校验失败，原文件仍保留'}:{assetId:id,status:'SUCCEEDED',material:{...material(id,e.fileName),...(invalidReceipt?{url:'/api/workspaces/foreign/assets/'+id+'/raw'}:{})}},req.method==='POST'?202:200);
    assert.equal(operation.operation,'link');assert.equal(operation.assetSha256,hash);links.push({assetId:id,projectId:operation.projectId});return json(res,material(id,e.fileName));
  }
  if(/\/assets\/[^/]+\/raw$/.test(url.pathname)){res.setHeader('Content-Type','image/png');return res.end(png);}
  if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
}
async function check(name,fn){await fn();report.checks.push({name,passed:true});}
(async()=>{
  const entryPath=path.join(directory,'entry.tsx');
  const component=path.join(repo,'apps/web/src/components/owned-canvas/OwnedBrandMaterialsDrawer.tsx').replace(/\\/g,'/');
  fs.writeFileSync(entryPath,`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{OwnedBrandMaterialsDrawer}from ${JSON.stringify(component)};function App(){const[open,setOpen]=useState(true),[project,setProject]=useState('p'),[readonly,setReadonly]=useState(false);window.receipts??=[];return <main className="mx-auto max-w-sm p-3"><button onClick={()=>setOpen(true)}>打开素材库</button><button onClick={()=>setProject(project==='p'?'p2':'p')}>切换项目</button><button onClick={()=>setReadonly(!readonly)}>切换只读</button>{open&&<OwnedBrandMaterialsDrawer workspaceId="w" userId="u" projectId={project} readOnly={readonly} onClose={()=>setOpen(false)} onInsert={material=>window.receipts.push({kind:'canvas',project,material})} onReference={material=>window.receipts.push({kind:'conversation',project,material})}/>}</main>}createRoot(document.getElementById('root')).render(<App/>);`);
  await esbuild.build({entryPoints:[entryPath],outfile:path.join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
  const css=spawnSync(process.execPath,[path.join(repo,'apps/web/node_modules/tailwindcss/lib/cli.js'),'-i',path.join(repo,'packages/ui/src/styles.css'),'-c',path.join(repo,'apps/web/tailwind.config.ts'),'--content',component+','+entryPath,'-o',path.join(directory,'app.css')],{cwd:repo,encoding:'utf8',env:{...process.env,TEMP:directory,TMP:directory},timeout:60000});
  assert.equal(css.status,0,css.stderr);
  server=http.createServer((req,res)=>{handle(req,res).catch(error=>{report.errors.push(error.message);json(res,{error:'fixture failure'},500);});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.NOVART_CHROMIUM_EXECUTABLE?{executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE}:{}),args:['--disable-background-networking']});
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage();
  page.on('pageerror',error=>report.errors.push(error.message));page.on('request',req=>{if(!req.url().startsWith(base)&&!req.url().startsWith('data:'))report.externalRequests.push(req.url());});
  await page.goto(base);const dialog=page.getByRole('dialog',{name:'品牌素材库'});
  await check('initial keyboard focus and real paginated list',async()=>{await page.getByRole('button',{name:'选择素材 品牌产品.png'}).waitFor();await page.getByRole('searchbox',{name:'搜索品牌素材'}).waitFor();assert.equal(await page.getByRole('searchbox').evaluate(el=>el===document.activeElement),true);await page.getByRole('button',{name:'加载更多'}).click();await page.getByRole('button',{name:'选择素材 包装参考.png'}).waitFor();});
  await check('selection alone never inserts or adds a conversation reference',async()=>{await page.getByRole('button',{name:'选择素材 品牌产品.png'}).click();assert.deepEqual(await page.evaluate(()=>window.receipts),[]);assert.equal(links.length,0);});
  await check('verified explicit conversation reference preserves canvas state',async()=>{await page.getByRole('button',{name:'加入对话',exact:true}).click();await page.getByText('已加入对话引用。画布选择保持不变。').waitFor();const r=await page.evaluate(()=>window.receipts);assert.equal(r.length,1);assert.equal(r[0].kind,'conversation');assert.equal(r[0].material.assetId,'a');});
  await check('verified same-brand material enters the real canvas callback',async()=>{await page.getByRole('button',{name:'加入画布',exact:true}).click();await page.getByText('已加入画布。品牌素材仍可在其他项目复用。').waitFor();assert.equal((await page.evaluate(()=>window.receipts)).at(-1).kind,'canvas');});
  await check('same Asset can be linked to another project without duplication',async()=>{await page.getByRole('button',{name:'切换项目'}).click();await page.getByRole('button',{name:'选择素材 品牌产品.png'}).click();await page.getByRole('button',{name:'加入画布',exact:true}).click();await page.getByText('已加入画布。品牌素材仍可在其他项目复用。').waitFor();assert.equal(links.at(-1).assetId,'a');assert.equal(links.at(-1).projectId,'p2');assert.equal(entries.size,2);});
  await check('a foreign material URL cannot reach insertion callback',async()=>{invalidReceipt=true;const count=(await page.evaluate(()=>window.receipts)).length;await page.getByRole('button',{name:'加入对话',exact:true}).click();await page.getByRole('alert').filter({hasText:'不属于当前品牌'}).waitFor();assert.equal((await page.evaluate(()=>window.receipts)).length,count);invalidReceipt=false;});
  await check('403 is visible and preserves the selected Asset',async()=>{deny=true;await page.getByRole('button',{name:'加入画布',exact:true}).click();await page.getByRole('alert').filter({hasText:'权限不足'}).waitFor();assert.equal(entries.has('a'),true);deny=false;});
  await check('failed content verification keeps the original asset and offers no insertion',async()=>{failedVerification=true;const count=(await page.evaluate(()=>window.receipts)).length;await page.getByRole('button',{name:'加入画布',exact:true}).click();await page.getByRole('alert').filter({hasText:'实际图片内容校验失败'}).waitFor();assert.equal((await page.evaluate(()=>window.receipts)).length,count);assert.equal(entries.has('a'),true);failedVerification=false;});
  await check('local file upload saves brand-first; closing does not remove it or add it to canvas',async()=>{const count=(await page.evaluate(()=>window.receipts)).length;await page.locator('input[type=file]').setInputFiles({name:'本地新增.png',mimeType:'image/png',buffer:png});await page.getByText('图片已保存到品牌素材库，可以选择加入画布或对话。').waitFor();await page.getByRole('button',{name:'关闭品牌素材库'}).click();await page.getByRole('button',{name:'打开素材库'}).click();await page.getByRole('searchbox').fill('本地新增');await page.getByRole('button',{name:'选择素材 本地新增.png'}).waitFor();assert.equal(entries.size,3);assert.equal(uploadTasks.size,1);assert.equal((await page.evaluate(()=>window.receipts)).length,count);});
  await check('pasting and dropping a file reuse the same persistent upload contract',async()=>{await page.getByRole('searchbox').fill('');await page.getByRole('searchbox').evaluate((el,base64)=>{const b=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([b],'粘贴.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));},png.toString('base64'));await page.getByText('图片已保存到品牌素材库，可以选择加入画布或对话。').waitFor();await dialog.evaluate((el,base64)=>{const b=Uint8Array.from(atob(base64),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([b],'拖入.png',{type:'image/png'}));el.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));},png.toString('base64'));await page.waitForFunction(()=>document.querySelectorAll('[aria-label="选择素材 拖入.png"]').length||document.querySelector('section')?.textContent.includes('图片已保存'));await page.waitForTimeout(400);assert.equal(uploadTasks.size,3);});
  await check('readonly disables writes while leaving library browsing available',async()=>{await page.getByRole('button',{name:'切换只读'}).click();assert.equal(await page.getByRole('button',{name:'上传',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'加入画布',exact:true}).isDisabled(),true);await page.getByText('当前项目只读，可以浏览品牌素材。').waitFor();await page.getByRole('button',{name:'切换只读'}).click();});
  await check('390px viewport does not overflow and Escape closes the dialog',async()=>{await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.getByRole('searchbox').press('Escape');assert.equal(await dialog.count(),0);});
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);
  fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,checks:report.checks.length,report:path.join(directory,'report.json'),isolated:true,realBackend:false,realProvider:false}));
})().catch(error=>{report.errors.push(error.stack||String(error));fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

/* Real React components and CSS, isolated synthetic transport only.
 * Checks library identity / brand destination interactions, not auth, DB or model quality.
 */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawnSync}=require('node:child_process'),{chromium}=require('playwright-core');
const repo=path.resolve(__dirname,'..'),temporary=path.join(repo,'.novart-build/temporary');fs.mkdirSync(temporary,{recursive:true});
const directory=fs.mkdtempSync(path.join(temporary,'inspiration-library-'));
const reportPath=process.env.NOVART_INSPIRATION_LIBRARY_REPORT||path.join(repo,'.novart-build/reports/inspiration-library-'+Date.now()+'.json');fs.mkdirSync(path.dirname(reportPath),{recursive:true});
const report={isolated:true,realBackend:false,realAuthentication:false,realProvider:false,providerCalls:0,checks:[],errors:[],unexpectedRequests:[],externalRequests:[],passed:false};
const library={id:'synthetic-company-library',kind:'SHARED'},legacy={id:'synthetic-legacy-library',kind:'WORKSPACE'};
const brands=[{id:'brand-a',name:'测试品牌甲',role:'OWNER'},{id:'brand-b',name:'测试品牌乙',role:'EDITOR'},{id:'brand-c',name:'只读品牌',role:'VIEWER'}];
const uuid='c78bfd95-d837-47de-a13c-aae41b32ea3f';
let browser,server,receipt=null,denied=false,posts=[],details=[],saved=[],chats=[];
const check=name=>report.checks.push(name);
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
function card(ws,source=library){return{libraryId:source.id,caseId:'same-case',revision:1,title:source.id===library.id?'公司共享案例':'旧品牌案例',summary:'只用于交互自测的合成记录',brandOrTeam:'合成来源',analysisAllowed:true,tags:{},images:[{imageId:'image-1',url:`/api/workspaces/${ws}/inspiration/cases/same-case/images/image-1?libraryId=${source.id}&revision=1`}],sources:[],claims:[]};}
async function start(){
 const pkg=fs.readdirSync(path.join(repo,'node_modules/.pnpm')).find(n=>/^esbuild@/.test(n)),esbuild=require(path.join(repo,'node_modules/.pnpm',pkg,'node_modules/esbuild'));
 const entry=path.join(directory,'entry.tsx'),nav=path.join(directory,'navigation.ts');
 fs.writeFileSync(nav,"export function useSearchParams(){return new URLSearchParams(location.search);}");
 fs.writeFileSync(entry,`import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import Client from ${JSON.stringify(path.join(repo,'apps/web/src/app/inspiration/inspiration-client').replaceAll('\\','/'))};import BrandContext from ${JSON.stringify(path.join(repo,'apps/web/src/app/inspiration/inspiration-brand-context').replaceAll('\\','/'))};const brands=${JSON.stringify(brands)},brand=brands.find(b=>b.id===new URLSearchParams(location.search).get('workspaceId'))||brands[0];const cache=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});createRoot(document.getElementById('root')!).render(<QueryClientProvider client={cache}><main className="mx-auto max-w-7xl px-5 py-6 sm:px-8"><BrandContext workspaceId={brand.id} workspaceName={brand.name} workspaces={brands} query={location.search}/><Client wsId={brand.id} workspaceName={brand.name} canEdit={brand.role!=='VIEWER'}/></main></QueryClientProvider>);`);
 await esbuild.build({entryPoints:[entry],outfile:path.join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},logLevel:'silent',plugins:[{name:'local-nav',setup(build){build.onResolve({filter:/^next\/navigation$/},()=>({path:nav}));}}]});
 const css=spawnSync(process.execPath,[path.join(repo,'apps/web/node_modules/tailwindcss/lib/cli.js'),'-i',path.join(repo,'packages/ui/src/styles.css'),'-o',path.join(directory,'tokens.css'),'-c',path.join(repo,'apps/web/tailwind.config.ts'),'--content',['apps/web/src/app/inspiration/*.tsx','apps/web/src/app/(brandai)/_ui.tsx','packages/ui/src/**/*.{ts,tsx}'].map(v=>path.join(repo,v)).join(',')],{cwd:repo,encoding:'utf8',timeout:60000});assert.equal(css.status,0,css.stderr);
 server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/inspiration'){res.writeHead(200,{'Content-Type':'text/html'});return res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tokens.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}
  if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
  if(['/app.js','/tokens.css'].includes(url.pathname)){res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript':'text/css');return res.end(fs.readFileSync(path.join(directory,url.pathname.slice(1))));}
  if(/^\/fonts\/inter-latin-(400|500|600)\.woff2$/.test(url.pathname)){res.setHeader('Content-Type','font/woff2');return res.end(fs.readFileSync(path.join(repo,'apps/web/public',url.pathname)));}
  const match=url.pathname.match(/^\/api\/workspaces\/(brand-[abc])\/(.*)$/);
  if(!match){report.unexpectedRequests.push(url.pathname);return json(res,{error:'Unknown isolated route'},404);}
  const ws=match[1],route=match[2];let body=null;
  if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;body=raw?JSON.parse(raw):{};posts.push({ws,route,body});}
  if(route==='projects')return json(res,[{id:'project-'+ws,name:'项目 '+ws}]);
  if(route==='inspiration'&&denied)return json(res,{error:'当前账号不再具有此品牌灵感库读取权限。'},403);
  if(route==='inspiration')return json(res,{enabled:true,syncConfigured:true,sourceLibrary:library,activeRelease:{id:'shared-release',sequence:1,createdAt:new Date().toISOString()},caseCount:1,withdrawalSequence:0,lastSyncAt:null,error:null,searchMode:'keyword-tags',cases:[card(ws)]});
  if(route==='inspiration/sync'){
   if(req.method==='POST'){receipt={id:'shared-task',status:'RUNNING',error:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+360000).toISOString()};return json(res,{id:receipt.id,status:receipt.status},202);}
   return json(res,{enabled:true,configured:true,mode:'manual',canReceive:ws==='brand-a',canReceiveReason:ws==='brand-a'?null:'请由公司灵感库管理员接收；当前品牌仍可引用共享案例。',sourceLibrary:library,task:receipt});
  }
  if(route==='inspiration/cases/same-case'){
   const id=url.searchParams.get('libraryId');details.push({ws,libraryId:id});
   if(![library.id,legacy.id].includes(id))return json(res,{error:'Missing source identity'},400);
   return json(res,card(ws,id===legacy.id?legacy:library));
  }
  if(route==='inspiration/cases/same-case/images/image-1'){
   if(![library.id,legacy.id].includes(url.searchParams.get('libraryId')))return json(res,{error:'Missing image source'},400);
   res.setHeader('Content-Type','image/png');return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'));
  }
  if(route==='inspiration/bookmarks'){
   if(req.method==='POST'){saved.push({ws,...body});return json(res,{id:'saved-'+saved.length});}
   const rows=saved.filter(r=>r.ws===ws).map((r,i)=>({id:'saved-'+i,...r,projectId:r.projectId||null,case:card(ws,r.libraryId===legacy.id?legacy:library),unavailable:false}));
   if(ws==='brand-a')rows.push({id:'old-private-bookmark',libraryId:legacy.id,caseId:'same-case',revision:1,projectId:null,note:'旧品牌私有笔记',case:card(ws,legacy),unavailable:false});
   return json(res,{items:rows});
  }
  if(route==='inspiration/feedback'){if(req.method==='POST')return json(res,{id:'feedback'});return json(res,{items:[],scope:'mine',canReview:false});}
  if(route==='inspiration/chat'){
   if(req.method==='POST'){chats.push({ws,...body});return json(res,{id:'chat-new',conversationId:uuid,status:'SUCCEEDED'},202);}
   const old=url.searchParams.get('conversationId')==='old-conversation',current=chats.filter(c=>c.ws===ws).at(-1);
   return json(res,{items:old?[{id:'old-chat',conversationId:'old-conversation',status:'SUCCEEDED',question:'历史问题',answer:'旧库回答',citations:[card(ws,legacy)],sourceLibrary:legacy,error:null,createdAt:new Date().toISOString()}]:current?[{id:'chat-new',conversationId:uuid,status:'SUCCEEDED',question:current.question,answer:'合成回答',citations:[card(ws)],sourceLibrary:library,error:null,createdAt:new Date().toISOString()}]:[]});
  }
  report.unexpectedRequests.push(req.method+':'+url.pathname);return json(res,{error:'Unknown isolated route'},404);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;
}
async function openCase(page,title='公司共享案例'){await page.getByTestId('inspiration-case').filter({hasText:title}).click();const dialog=page.getByRole('dialog',{name:'案例详情'});await dialog.getByRole('heading',{name:title,exact:true}).waitFor();return dialog;}
async function closeCase(dialog){await dialog.getByRole('button',{name:'关闭详情',exact:true}).click();}
(async()=>{
 const origin=await start();browser=await chromium.launch({executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined),headless:true,args:['--disable-background-networking','--no-proxy-server']});
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  posts=[];details=[];saved=[];chats=[];receipt=null;denied=false;
  const context=await browser.newContext({viewport,locale:'zh-CN',reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(origin+'/inspiration?workspaceId=brand-a&q=字体');await page.getByRole('heading',{name:'统一灵感库',exact:true}).waitFor();
  let dialog=await openCase(page);assert.deepEqual(details.at(-1),{ws:'brand-a',libraryId:library.id});
  await dialog.getByRole('combobox',{name:'收藏项目',exact:true}).selectOption('project-brand-a');await dialog.getByRole('textbox',{name:'案例借鉴点'}).fill('品牌甲项目笔记');await dialog.getByRole('button',{name:'保存案例',exact:true}).click();await dialog.getByText(/已保存到测试品牌甲的项目收藏/).waitFor();
  assert.equal(saved.at(-1).libraryId,library.id);assert.equal(saved.at(-1).projectId,'project-brand-a');assert.equal(saved.at(-1).ws,'brand-a');assert.ok(await dialog.getByText(/不会自动加入画布/).isVisible());check(viewport.width+': shared source saved only to the selected brand project with honest reference wording');
  await dialog.getByText('反馈案例问题',{exact:true}).click();await dialog.getByRole('button',{name:'提交反馈',exact:true}).click();await dialog.getByText('反馈已进入工作区审核队列。',{exact:true}).waitFor();assert.equal(posts.filter(p=>p.route==='inspiration/feedback').at(-1).body.libraryId,library.id);
  await dialog.getByRole('checkbox',{name:'image-1',exact:true}).check();await closeCase(dialog);await page.getByRole('textbox',{name:'向灵感助手提问'}).fill('请比较这个案例');await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText('合成回答',{exact:true}).waitFor();assert.equal(chats.at(-1).libraryId,library.id);assert.equal(chats.at(-1).selectedImages[0].libraryId,library.id);check(viewport.width+': feedback chat and selected image keep source library identity');
  await page.getByRole('button',{name:'我的收藏',exact:true}).click();await page.getByRole('button',{name:'旧品牌案例',exact:true}).click();dialog=page.getByRole('dialog',{name:'案例详情'});await dialog.getByRole('heading',{name:'旧品牌案例',exact:true}).waitFor();assert.equal(details.at(-1).libraryId,legacy.id);await closeCase(dialog);check(viewport.width+': identical case id in legacy bookmark resolves its original library');
  await page.getByRole('button',{name:'接收最新灵感',exact:true}).click();await page.getByRole('button',{name:'正在接收…',exact:true}).waitFor();
  await page.locator('summary').filter({hasText:'引用到：测试品牌甲'}).click();await page.getByRole('link',{name:'测试品牌乙',exact:true}).click();await page.getByRole('button',{name:'正在接收…',exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('workspaceId'),'brand-b');assert.equal(new URL(page.url()).searchParams.get('q'),'字体');assert.equal(new URL(page.url()).searchParams.has('conversationId'),false);assert.equal(posts.filter(p=>p.route==='inspiration/sync').length,1);await page.getByText('请由公司灵感库管理员接收；当前品牌仍可引用共享案例。',{exact:true}).waitFor();await page.getByRole('button',{name:'我的收藏',exact:true}).click();await page.getByText(/尚未收藏案例/).waitFor();assert.equal(await page.getByText('旧品牌私有笔记',{exact:true}).count(),0);check(viewport.width+': navigation shares one receipt but resets private brand conversation and bookmarks');
  receipt=null;await page.goto(origin+'/inspiration?workspaceId=brand-a&conversationId=old-conversation');await page.getByText('旧库回答',{exact:true}).waitFor();dialog=await openCase(page);await dialog.getByRole('checkbox',{name:'image-1',exact:true}).check();await closeCase(dialog);await page.getByRole('textbox',{name:'向灵感助手提问'}).fill('继续比较');const before=chats.length;await page.getByRole('button',{name:'发送',exact:true}).click();await page.getByText(/所选图片与当前对话来自不同灵感库/).waitFor();assert.equal(chats.length,before);check(viewport.width+': old-library conversation cannot silently submit a different library image');
  await page.goto(origin+'/inspiration?workspaceId=brand-c');await page.getByRole('heading',{name:'统一灵感库',exact:true}).waitFor();await page.getByText(/你在此品牌具有只读权限；收藏与问答需要编辑权限/).waitFor();assert.equal(await page.getByRole('button',{name:'接收最新灵感',exact:true}).isDisabled(),true);dialog=await openCase(page);assert.equal(await dialog.getByRole('button',{name:'保存案例',exact:true}).isDisabled(),true);assert.equal(await dialog.getByRole('checkbox',{name:'image-1',exact:true}).isDisabled(),true);await closeCase(dialog);await page.getByRole('textbox',{name:'向灵感助手提问'}).fill('无权提交');assert.equal(await page.getByRole('button',{name:'发送',exact:true}).isDisabled(),true);check(viewport.width+': read-only brand can browse but cannot mutate references or chat');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);check(viewport.width+': actual shared library UI fits viewport');denied=true;await page.getByRole('button',{name:'刷新状态',exact:true}).click();await page.getByText('当前账号不再具有此品牌灵感库读取权限。',{exact:true}).waitFor();assert.equal(await page.getByTestId('inspiration-case').count(),0);assert.equal(await page.getByRole('button',{name:'接收最新灵感',exact:true}).count(),0);check(viewport.width+': revoked read permission immediately hides cached cases and actions');await context.close();
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.unexpectedRequests,[]);assert.deepEqual(report.externalRequests,[]);report.passed=true;
})().catch(error=>{report.errors.push(error.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,errors:report.errors,reportPath}));});

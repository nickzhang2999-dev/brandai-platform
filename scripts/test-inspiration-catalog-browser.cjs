/* Actual InspirationClient, catalog filtering and product CSS in fresh Chromium.
 * The local GET-only service is synthetic: no real account, database, source,
 * model, or publisher is exercised. Navigation shim only subscribes to URL state.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');

const repo = path.resolve(__dirname, '..');
const reportPath = process.env.NOVART_INSPIRATION_CATALOG_REPORT || path.join(repo, '.novart-build/reports/inspiration-catalog-' + Date.now() + '.json');
const temporaryRoot = path.join(repo, '.novart-build/temporary');
fs.mkdirSync(temporaryRoot, {recursive:true});
fs.mkdirSync(path.dirname(reportPath), {recursive:true});
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'inspiration-catalog-'));
const previousTemp = {TEMP:process.env.TEMP, TMP:process.env.TMP};
process.env.TEMP = directory; process.env.TMP = directory;
const report = {
  isolated:true, realBackend:false, realAuthentication:false, realProvider:false, providerCalls:0,
  scope:'Actual inspiration React components, production catalog filter and Tailwind tokens; synthetic GET-only local API',
  checks:[], errors:[], externalRequests:[], unexpectedRequests:[], writeRequests:0, passed:false,
};
const workspace = 'catalog-workspace';
const conversation = '11111111-1111-4111-8111-111111111111';
const base = `/api/workspaces/${workspace}/inspiration`;
const now = '2026-10-26T05:00:00.000Z';
const manifestHash = 'a'.repeat(64), withdrawalHash = 'b'.repeat(64);
const cases = [
  {caseId:'tea-package', title:'茶饮包装测试', contentType:'reference', taxonomyStatus:'reviewed', tags:{industry:['food-beverage'],medium:['packaging'],task:['series']}, summary:'字体主导的系列包装，仅用于隔离交互测试。',analysisAllowed:true,images:[{imageId:'fixture-image',url:'/isolated-image.png'}]},
  {caseId:'technology-ad', title:'科技海报测试', contentType:'advertisement', taxonomyStatus:'reviewed', tags:{industry:['technology'],medium:['poster'],task:['campaign']}, summary:'传播活动海报，仅用于隔离交互测试。'},
  {caseId:'culture-reference', title:'出版设计测试', contentType:'reference', taxonomyStatus:'reviewed', tags:{industry:['culture'],medium:['editorial'],task:[]}, summary:'编辑出版参考，仅用于隔离交互测试。'},
  {caseId:'legacy-reference', title:'旧版分类测试', contentType:'reference', taxonomyStatus:'legacy', tags:{industry:[],medium:[],task:[]}, summary:'旧版分类尚未补审，仅用于隔离交互测试。'},
].map(value => ({revision:1,brandOrTeam:'隔离测试团队',analysisAllowed:false,images:[],sources:[],claims:[],...value}));
const listRequests = [];
const contentRequests = [];
let server, browser, stage = 'compile', phase = 'healthy', filterCatalog;
const check = name => report.checks.push(name);
const json = (res, value, status=200) => {res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};

function syncStatus() {
  const channel = {state:'healthy',lastAttemptAt:now,lastSuccessAt:now,lastFailureAt:null,error:null};
  return {
    content: phase === 'content-error' ? {...channel,state:'error',lastFailureAt:now,error:'内容更新暂未成功，请稍后重试。'} : {...channel},
    withdrawals: phase === 'withdrawal-error' ? {...channel,state:'error',lastFailureAt:now,error:'撤回检查暂未成功，请稍后重试。'}
      : phase === 'withdrawal-stale' ? {...channel,state:'stale'} : {...channel},
    activeManifestHash:manifestHash, withdrawalHash,
  };
}

async function start() {
  const esbuildPackage = fs.readdirSync(path.join(repo,'node_modules/.pnpm')).find(name => name.startsWith('esbuild@0.28.'));
  assert.ok(esbuildPackage, 'Use installed esbuild without downloading tools');
  const esbuild = require(path.join(repo,'node_modules/.pnpm',esbuildPackage,'node_modules/esbuild'));
  const entry = path.join(directory,'entry.tsx'), navigation = path.join(directory,'navigation.ts');
  fs.writeFileSync(navigation, `import {useMemo,useSyncExternalStore} from 'react';
const event='fixture-navigation';
for(const method of ['replaceState','pushState'] as const){const original=history[method].bind(history);history[method]=(...args:Parameters<History[typeof method]>)=>{original(...args);window.dispatchEvent(new Event(event));};}
const subscribe=(callback:()=>void)=>{window.addEventListener('popstate',callback);window.addEventListener(event,callback);return()=>{window.removeEventListener('popstate',callback);window.removeEventListener(event,callback);};};
export function useSearchParams(){const search=useSyncExternalStore(subscribe,()=>location.search);return useMemo(()=>new URLSearchParams(search),[search]);}
`);
  fs.writeFileSync(entry, `import React from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import InspirationClient from ${JSON.stringify(path.join(repo,'apps/web/src/app/inspiration/inspiration-client').replaceAll('\\','/'))};
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><main className="mx-auto max-w-7xl px-5 py-6 sm:px-8"><InspirationClient wsId=${JSON.stringify(workspace)}/></main></QueryClientProvider>);
`);
  await esbuild.build({
    entryPoints:[entry],outfile:path.join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',
    tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],
    define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},logLevel:'silent',
    plugins:[{name:'local-navigation-subscription',setup(build){build.onResolve({filter:/^next\/navigation$/},()=>({path:navigation}));}}],
  });
  const compiledCatalog = path.join(directory,'catalog.cjs');
  await esbuild.build({entryPoints:[path.join(repo,'apps/web/src/lib/inspiration/catalog.ts')],outfile:compiledCatalog,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
  ({filterCatalog} = require(compiledCatalog));
  const css = spawnSync(process.execPath,[path.join(repo,'apps/web/node_modules/tailwindcss/lib/cli.js'),'-i',path.join(repo,'packages/ui/src/styles.css'),'-o',path.join(directory,'tokens.css'),'-c',path.join(repo,'apps/web/tailwind.config.ts'),'--content',[
    'apps/web/src/app/inspiration/*.tsx','apps/web/src/app/(brandai)/_ui.tsx','packages/ui/src/**/*.{ts,tsx}',
  ].map(value=>path.join(repo,value)).join(',')],{cwd:repo,encoding:'utf8',timeout:60000});
  assert.equal(css.status,0,'Actual product CSS must compile: '+css.stderr);
  server=http.createServer((req,res)=>{
    const url = new URL(req.url,'http://127.0.0.1');
    if(!['GET','HEAD'].includes(req.method)){report.writeRequests++;return json(res,{error:'Isolated acceptance must not write'},405);}
    if(url.pathname==='/inspiration'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      return res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tokens.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
    }
    if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
    if(url.pathname==='/isolated-image.png'){
      res.setHeader('Content-Type','image/png');
      return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'));
    }
    if(['/app.js','/tokens.css'].includes(url.pathname)){
      res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript':'text/css');
      return res.end(fs.readFileSync(path.join(directory,url.pathname.slice(1))));
    }
    if(['/fonts/inter-latin-400.woff2','/fonts/inter-latin-500.woff2','/fonts/inter-latin-600.woff2'].includes(url.pathname)){
      const file=path.join(repo,'apps/web/public',url.pathname);
      if(!fs.existsSync(file))return json(res,{error:'Missing product font'},404);
      res.setHeader('Content-Type','font/woff2');return res.end(fs.readFileSync(file));
    }
    if(url.pathname===base){
      const filters=Object.fromEntries(url.searchParams);listRequests.push(filters);
      if(phase==='disabled') return json(res,{enabled:false,syncConfigured:true,activeRelease:null,caseCount:0,withdrawalSequence:0,lastSyncAt:null,error:null,cases:[],searchMode:'keyword-tags'});
      return json(res,{enabled:true,syncConfigured:true,activeRelease:{id:'isolated-release',sequence:1,createdAt:now},caseCount:cases.length,withdrawalSequence:1,lastSyncAt:now,error:null,cases:filterCatalog(cases,filters),searchMode:'keyword-tags',...(phase==='old-response'?{}:{syncStatus:syncStatus()})});
    }
    if(url.pathname.startsWith(base+'/')){
      contentRequests.push({path:url.pathname,phase});
      if(phase==='disabled') return json(res,{error:{message:'Disabled isolated library'}},503);
    }
    if(url.pathname===base+'/bookmarks')return json(res,{items:[]});
    if(url.pathname===base+'/chat')return json(res,{items:[{id:'isolated-chat',conversationId:conversation,status:'SUCCEEDED',question:'隔离测试历史问题',answer:'已缓存的测试回答',citations:[],error:null,createdAt:now}]});
    if(url.pathname===`/api/workspaces/${workspace}/projects`)return json(res,[]);
    if(url.pathname.startsWith(base+'/cases/')){
      if(phase==='detail-error') return json(res,{error:{message:'Isolated detail is temporarily unavailable'}},503);
      const item=cases.find(item=>item.caseId===url.pathname.slice((base+'/cases/').length));
      return item?json(res,item):json(res,{error:'Unknown isolated case'},404);
    }
    report.unexpectedRequests.push(url.pathname);return json(res,{error:'Unknown isolated route'},404);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return 'http://127.0.0.1:'+server.address().port;
}

async function displayed(page, expected) {
  await page.getByText(`当前显示 ${expected} 个案例`,{exact:true}).waitFor();
  assert.equal(await page.getByTestId('inspiration-case').count(),expected);
}
function selection(page, label) {return page.getByRole('combobox',{name:label,exact:true});}
async function noOverflow(page) {assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'The actual page must fit its viewport');}

(async()=>{
  const origin=await start();
  browser=await chromium.launch({executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined),headless:true,args:['--disable-background-networking','--no-proxy-server']});
  for(const spec of [{name:'desktop-1440',width:1440,height:960},{name:'mobile-390',width:390,height:844}]){
    stage=spec.name;phase='healthy';
    const ctx=await browser.newContext({viewport:{width:spec.width,height:spec.height},locale:'zh-CN',reducedMotion:'reduce',serviceWorkers:'block'});
    await ctx.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
    const page=await ctx.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push({stage,message:error.message}));
    await page.clock.install();
    await page.goto(origin+'/inspiration?'+new URLSearchParams({workspaceId:workspace,conversationId:conversation}));
    await displayed(page,4);await noOverflow(page);
    const tea=page.getByTestId('inspiration-case').filter({has:page.getByRole('heading',{name:'茶饮包装测试',exact:true})});
    assert.ok(await tea.getByText('食品饮料',{exact:true}).isVisible());assert.ok(await tea.getByText('包装',{exact:true}).isVisible());assert.ok(await tea.getByText('系列扩展',{exact:true}).isVisible());
    assert.equal(await tea.getByText('food-beverage',{exact:true}).count(),0);
    const legacy=page.getByTestId('inspiration-case').filter({has:page.getByRole('heading',{name:'旧版分类测试',exact:true})});
    assert.ok(await legacy.getByText('分类待补审',{exact:true}).isVisible());assert.equal(await legacy.getByText('数字界面',{exact:true}).count(),0);
    check(spec.name+': readable Chinese tags and explicit legacy classification');

    const updates=page.getByRole('region',{name:'灵感库更新状态',exact:true});
    assert.equal(await updates.getByText('正常',{exact:true}).count(),2);
    assert.equal(await updates.locator('details').getAttribute('open'),null);
    assert.equal(await updates.getByText(manifestHash,{exact:true}).isVisible(),false);
    await updates.getByText('查看更新详情',{exact:true}).click();
    assert.ok(await updates.getByText(manifestHash,{exact:true}).isVisible());assert.ok(await updates.getByText(withdrawalHash,{exact:true}).isVisible());await noOverflow(page);
    await updates.getByText('查看更新详情',{exact:true}).click();
    check(spec.name+': independent successful channels with hashes collapsed by default');

    const before=listRequests.length;
    await page.getByRole('textbox',{name:'搜索案例',exact:true}).fill('字体');
    await selection(page,'案例类型').selectOption('reference');
    await selection(page,'行业筛选').selectOption('food-beverage');
    await selection(page,'媒介筛选').selectOption('packaging');
    await selection(page,'设计任务').selectOption('series');
    assert.equal(listRequests.length,before,'Unsubmitted filter edits must not issue a new search');
    assert.equal(new URL(page.url()).searchParams.has('kind'),false);
    await page.getByRole('button',{name:'查找',exact:true}).click();await displayed(page,1);
    assert.deepEqual(listRequests.at(-1),{q:'字体',kind:'reference',industry:'food-beverage',medium:'packaging',task:'series'});
    assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams),{workspaceId:workspace,conversationId:conversation,q:'字体',kind:'reference',industry:'food-beverage',medium:'packaging',task:'series'});
    assert.ok(await tea.isVisible());check(spec.name+': four dimensions and keyword submit atomically into API and URL');
    await page.reload();await displayed(page,1);
    assert.equal(await page.getByRole('textbox',{name:'搜索案例',exact:true}).inputValue(),'字体');
    for(const [label,value]of [['案例类型','reference'],['行业筛选','food-beverage'],['媒介筛选','packaging'],['设计任务','series']])assert.equal(await selection(page,label).inputValue(),value);
    assert.equal(new URL(page.url()).searchParams.get('workspaceId'),workspace);assert.equal(new URL(page.url()).searchParams.get('conversationId'),conversation);
    check(spec.name+': refresh restores all filters without losing workspace or conversation');
    await page.getByRole('button',{name:'清除筛选',exact:true}).click();await displayed(page,4);
    assert.deepEqual(Object.fromEntries(new URL(page.url()).searchParams),{workspaceId:workspace,conversationId:conversation});
    assert.equal(await page.getByRole('textbox',{name:'搜索案例',exact:true}).inputValue(),'');
    for(const label of ['案例类型','行业筛选','媒介筛选','设计任务'])assert.equal(await selection(page,label).inputValue(),'');
    check(spec.name+': clearing filters preserves unrelated deep-link identity');

    await selection(page,'案例类型').selectOption('advertisement');await page.getByRole('button',{name:'查找',exact:true}).click();await displayed(page,1);
    assert.ok(await page.getByRole('heading',{name:'科技海报测试',exact:true}).isVisible());
    await selection(page,'媒介筛选').selectOption('packaging');await page.getByRole('button',{name:'查找',exact:true}).click();await displayed(page,0);
    await page.getByRole('heading',{name:'没有符合这些条件的案例',exact:true}).waitFor();
    await page.getByRole('button',{name:'清除筛选',exact:true}).click();await displayed(page,4);
    await selection(page,'媒介筛选').selectOption('digital');await page.getByRole('button',{name:'查找',exact:true}).click();await displayed(page,0);
    await page.getByRole('button',{name:'清除筛选',exact:true}).click();await displayed(page,4);
    check(spec.name+': ads stay distinct from references and legacy defaults never match digital media');

    phase='withdrawal-error';await page.getByRole('button',{name:'刷新状态',exact:true}).click();
    await updates.getByText('撤回检查暂未成功，请稍后重试。',{exact:true}).waitFor();
    assert.equal(await updates.getByText('正常',{exact:true}).count(),1);assert.equal(await updates.getByText('暂未成功',{exact:true}).count(),1);
    assert.ok(await updates.getByText(/已知撤回仍生效/).isVisible());assert.equal(await updates.getByText(/正在展示上次同步成功/).count(),0);
    assert.equal(await page.getByTestId('inspiration-case').count(),4);check(spec.name+': withdrawal failure does not hide successful content or cached cases');
    phase='content-error';await page.getByRole('button',{name:'刷新状态',exact:true}).click();
    await updates.getByText('内容更新暂未成功，请稍后重试。',{exact:true}).waitFor();
    assert.equal(await updates.getByText('正常',{exact:true}).count(),1);assert.ok(await updates.getByText(/正在展示上次同步成功/).isVisible());
    assert.equal(await updates.getByText(/已知撤回仍生效/).count(),0);check(spec.name+': content failure and recovery keep the other channel independent');
    phase='withdrawal-stale';await page.getByRole('button',{name:'刷新状态',exact:true}).click();await updates.getByText('需要检查',{exact:true}).waitFor();
    assert.ok(await updates.getByText(/已知撤回仍生效/).isVisible());check(spec.name+': stale withdrawal checks are not shown as healthy');
    phase='old-response';await page.getByRole('button',{name:'刷新状态',exact:true}).click();
    await page.getByText('当前服务暂未提供独立同步检查记录。',{exact:true}).waitFor();assert.equal(await page.getByTestId('inspiration-case').count(),4);
    check(spec.name+': an older response never fabricates channel health');
    await noOverflow(page);check(spec.name+': actual rendered page fits viewport');

    await page.getByText('已缓存的测试回答',{exact:true}).waitFor();
    await tea.click();
    const detail=page.getByRole('dialog',{name:'案例详情',exact:true});
    await detail.getByRole('checkbox',{name:'fixture-image',exact:true}).check();
    phase='disabled';
    await page.clock.fastForward(60001);
    await page.getByRole('heading',{name:'灵感库尚未开放',exact:true}).waitFor();
    assert.equal(await page.getByRole('dialog',{name:'案例详情',exact:true}).count(),0);
    assert.equal(await page.getByText('已缓存的测试回答',{exact:true}).count(),0);
    assert.equal(await page.getByTestId('inspiration-case').count(),0);
    const requestsAfterDisabled=contentRequests.length;
    await page.evaluate(()=>{const url=new URL(location.href);url.searchParams.set('kind','advertisement');history.replaceState(null,'',url);});
    await page.waitForFunction(()=>location.search.includes('kind=advertisement'));
    await page.clock.fastForward(60001);
    assert.equal(contentRequests.length,requestsAfterDisabled,'Disabled content queries must stop');
    assert.equal(await page.getByTestId('inspiration-case').count(),0,'Previously cached filter results must not revive disabled content');
    check(spec.name+': disabling hides an open detail, historical answer and case data, then stops content reads');
    await page.evaluate(()=>{const url=new URL(location.href);url.searchParams.delete('kind');history.replaceState(null,'',url);});
    phase='healthy';await page.clock.fastForward(60001);await displayed(page,4);
    phase='detail-error';await tea.click();await detail.getByRole('alert').waitFor();
    assert.equal(await detail.getByRole('heading',{name:'茶饮包装测试',exact:true}).count(),0,'A failed fresh detail read must not reveal a pre-disable cached detail');
    await detail.getByRole('button',{name:'关闭详情',exact:true}).click();phase='healthy';
    await tea.click();
    await detail.getByRole('checkbox',{name:'fixture-image',exact:true}).waitFor();
    assert.equal(await detail.getByRole('checkbox',{name:'fixture-image',exact:true}).isChecked(),false,'Re-enabling must not restore selected images');
    await detail.getByRole('button',{name:'关闭详情',exact:true}).click();
    check(spec.name+': re-enabling fetches current data with no previous image selection');

    phase='disabled';const readsBeforeDisabledLoad=contentRequests.length;
    await page.reload();await page.getByRole('heading',{name:'灵感库尚未开放',exact:true}).waitFor();
    assert.equal(contentRequests.length,readsBeforeDisabledLoad,'Initial disabled deep links must not request conversation/detail/bookmarks');
    check(spec.name+': disabled conversation deep links do not fetch protected content');
    await ctx.close();
  }
  assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);assert.deepEqual(report.unexpectedRequests,[]);assert.equal(report.writeRequests,0);
  report.passed=true;
})().catch(error=>{report.fatal={stage,message:error.message,stack:error.stack};process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  for(const[name,value]of Object.entries(previousTemp))if(value===undefined)delete process.env[name];else process.env[name]=value;
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(temporaryRoot));fs.rmSync(directory,{recursive:true,force:true});
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,writeRequests:report.writeRequests,externalRequests:report.externalRequests,reportPath,fatal:report.fatal,errors:report.errors}));
});

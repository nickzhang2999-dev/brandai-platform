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
const reportPath = process.env.NOVART_INSPIRATION_PAGING_REPORT || path.join(repo, '.novart-build/reports/inspiration-catalog-' + Date.now() + '.json');
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
let delayed = [], cursorRequests = 0, epoch = 1;
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
      const first={...cases[0],caseId:'first',title:'第一页保留案例'};
      const tail={...cases[1],caseId:'tail',title:'旧分页案例'};
      const fresh={...cases[2],caseId:'fresh',title:'新筛选案例'};
      const payload=(items,hasMore=false)=>({enabled:true,syncConfigured:true,sourceLibrary:{id:'library',kind:'WORKSPACE'},activeRelease:{id:'release-'+epoch,sequence:epoch,createdAt:now},caseCount:2,matchedCount:2,withdrawalSequence:epoch,lastSyncAt:now,error:null,cases:items,hasMore,nextCursor:hasMore?'first':null,searchMode:'keyword-tags',syncStatus:syncStatus()});
      if(filters.cursor){
        cursorRequests++;
        if(phase==='race' || phase==='pending-withdrawal') {const frozen=payload([tail]);delayed.push(()=>json(res,frozen));return;}
        if(phase==='revoked') return json(res,{error:{message:'隔离权限已撤销'}},403);
        if(phase==='error') return json(res,{error:{message:'隔离分页失败'}},503);
        return json(res,payload([tail]));
      }
      if(phase==='revoked-all') return json(res,{error:{message:'隔离权限已撤销'}},403);
      if(filters.q==='新' || phase==='withdrawn') return json(res,payload([fresh]));
      return json(res,payload([first],true));
    }
    if(url.pathname===base+'/sync')return json(res,{enabled:phase!=='disabled',configured:true,mode:'manual',canReceive:false,task:null});
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
  for(const mode of ['race','pending-withdrawal','loaded-withdrawal','revoked','error']){
    stage=mode;phase=mode;epoch=1;cursorRequests=0;delayed=[];
    const ctx=await browser.newContext({viewport:{width:1440,height:960},locale:'zh-CN',serviceWorkers:'block'});
    await ctx.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
    const page=await ctx.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push({stage,message:error.message}));
    await page.goto(origin+'/inspiration');
    await page.waitForFunction(()=>document.querySelectorAll('[data-testid="inspiration-case"]').length>0 || document.body.textContent.includes('访问权限已失效'));
    if(mode!=='revoked') await page.getByText('第一页保留案例',{exact:true}).waitFor();
    // Both the manual fallback and observer use the real loadMore handler.
    if(mode!=='revoked' && cursorRequests===0) await page.getByRole('button',{name:/加载更多/}).scrollIntoViewIfNeeded();
    await new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(cursorRequests){clearInterval(timer);resolve();}else if(Date.now()-started>10000){clearInterval(timer);reject(new Error('No next-page request'));}},20);});
    if(mode==='race'){
      await page.getByRole('textbox',{name:'搜索案例',exact:true}).fill('新');
      await page.getByRole('button',{name:'查找',exact:true}).click();
      await page.getByText('新筛选案例',{exact:true}).waitFor();
      assert.equal(delayed.length,1);delayed.splice(0).forEach(release=>release());
      await page.waitForTimeout(250);
      assert.equal(await page.getByText('旧分页案例',{exact:true}).count(),0);
      assert.equal(await page.getByText('第一页保留案例',{exact:true}).count(),0);
      assert.equal(await page.getByTestId('inspiration-case').count(),1);
      check('Late old-filter page cannot append after the new filter response');
    } else if(mode==='pending-withdrawal' || mode==='loaded-withdrawal'){
      if(mode==='loaded-withdrawal')await page.getByText('旧分页案例',{exact:true}).waitFor();
      phase='withdrawn';epoch=2;
      await page.getByRole('button',{name:'刷新状态',exact:true}).click();
      await page.getByText('新筛选案例',{exact:true}).waitFor();
      delayed.splice(0).forEach(release=>release());await page.waitForTimeout(250);
      assert.equal(await page.getByText('旧分页案例',{exact:true}).count(),0);
      assert.equal(await page.getByTestId('inspiration-case').count(),1);
      check(mode+': new withdrawal/release epoch drops old pages and pending responses');
    } else if(mode==='revoked'){
      await page.getByRole('alert').filter({hasText:'访问权限已失效'}).waitFor();
      assert.equal(await page.getByTestId('inspiration-case').count(),0);
      assert.equal(await page.getByRole('dialog').count(),0);
      const before=cursorRequests;await page.waitForTimeout(700);assert.equal(cursorRequests,before);
      check('Pagination 403 clears protected cards and stops additional reads');
    } else {
      await page.getByRole('alert').filter({hasText:'服务暂时不可用'}).waitFor();
      const before=cursorRequests;await page.waitForTimeout(1000);assert.equal(cursorRequests,before,'Visible observer must not repeatedly retry failed pagination');
      await page.getByRole('button',{name:/加载更多/}).click();
      await page.waitForTimeout(500);assert.equal(cursorRequests,before+1,'Manual retry sends exactly one request');
      check('Failed automatic pagination stops; explicit manual retry sends one request');
    }
    await ctx.close();
  }
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.unexpectedRequests,[]);assert.equal(report.writeRequests,0);report.passed=true;
})().catch(error=>{report.fatal={stage,message:error.message,stack:error.stack};process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  for(const[name,value]of Object.entries(previousTemp))if(value===undefined)delete process.env[name];else process.env[name]=value;
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(temporaryRoot));fs.rmSync(directory,{recursive:true,force:true});
  console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,writeRequests:report.writeRequests,externalRequests:report.externalRequests,reportPath,fatal:report.fatal,errors:report.errors}));
});

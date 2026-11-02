/* Actual InspirationClient and product CSS; isolated synthetic API only.
 * Tests receipt interaction, never real publication, auth, DB, or model quality.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');
const repo = path.resolve(__dirname, '..');
const root = path.join(repo, '.novart-build/temporary'); fs.mkdirSync(root,{recursive:true});
const directory = fs.mkdtempSync(path.join(root,'inspiration-receive-'));
const reportPath = process.env.NOVART_INSPIRATION_RECEIVE_REPORT || path.join(repo,'.novart-build/reports/inspiration-receive-'+Date.now()+'.json');
fs.mkdirSync(path.dirname(reportPath),{recursive:true});
const report = {isolated:true,realBackend:false,realAuthentication:false,realProvider:false,providerCalls:0,checks:[],errors:[],externalRequests:[],unexpectedRequests:[],passed:false};
const scenarios = new Map(); let server,browser;
const check = name => report.checks.push(name);
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const fresh=()=>({task:null,allowed:true,configured:true,posts:0,count:1,mode:'manual',getFailure:false,loseResponse:false});
const task=(status,id='isolated-receipt')=>({id,status,error:status==='FAILED'?'知识包校验未通过，请检查发布端。':null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+360000).toISOString()});
function state(ws){if(!scenarios.has(ws))scenarios.set(ws,fresh());return scenarios.get(ws);}

async function start(){
 const pkg=fs.readdirSync(path.join(repo,'node_modules/.pnpm')).find(name=>/^esbuild@/.test(name));assert.ok(pkg);
 const esbuild=require(path.join(repo,'node_modules/.pnpm',pkg,'node_modules/esbuild'));
 const nav=path.join(directory,'navigation.ts'),entry=path.join(directory,'entry.tsx');
 fs.writeFileSync(nav,"export function useSearchParams(){return new URLSearchParams(location.search);}");
 fs.writeFileSync(entry,`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {QueryClient,QueryClientProvider} from '@tanstack/react-query';import InspirationClient from ${JSON.stringify(path.join(repo,'apps/web/src/app/inspiration/inspiration-client').replaceAll('\\','/'))};const cache=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false}}});function App(){const [ws,setWs]=useState('receive-a');return <QueryClientProvider client={cache}><button data-testid="switch-workspace" onClick={()=>setWs('receive-b')}>隔离测试切换品牌</button><main className="mx-auto max-w-7xl px-5 py-6 sm:px-8"><InspirationClient wsId={ws}/></main></QueryClientProvider>}createRoot(document.getElementById('root')!).render(<App/>);`);
 await esbuild.build({entryPoints:[entry],outfile:path.join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},logLevel:'silent',plugins:[{name:'local-nav',setup(build){build.onResolve({filter:/^next\/navigation$/},()=>({path:nav}));}}]});
 const css=spawnSync(process.execPath,[path.join(repo,'apps/web/node_modules/tailwindcss/lib/cli.js'),'-i',path.join(repo,'packages/ui/src/styles.css'),'-o',path.join(directory,'tokens.css'),'-c',path.join(repo,'apps/web/tailwind.config.ts'),'--content',['apps/web/src/app/inspiration/*.tsx','apps/web/src/app/(brandai)/_ui.tsx','packages/ui/src/**/*.{ts,tsx}'].map(value=>path.join(repo,value)).join(',')],{cwd:repo,encoding:'utf8',timeout:60000});assert.equal(css.status,0,css.stderr);
 server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/inspiration'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tokens.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}
  if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
  if(['/app.js','/tokens.css'].includes(url.pathname)){res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript':'text/css');return res.end(fs.readFileSync(path.join(directory,url.pathname.slice(1))));}
  if(/^\/fonts\/inter-latin-(400|500|600)\.woff2$/.test(url.pathname)){res.setHeader('Content-Type','font/woff2');return res.end(fs.readFileSync(path.join(repo,'apps/web/public',url.pathname)));}
  const match=url.pathname.match(/^\/api\/workspaces\/(receive-[ab])\/inspiration(.*)$/);
  if(!match){report.unexpectedRequests.push(url.pathname);return json(res,{error:'Unknown isolated route'},404);}
  const s=state(match[1]),suffix=match[2];
  if(suffix==='/sync'){
   if(req.method==='POST'){s.posts++;s.task=task('PENDING',match[1]+'-'+s.posts);return setTimeout(()=>json(res,s.loseResponse?{error:'Isolated lost response'}:{id:s.task.id,status:s.task.status},s.loseResponse?502:202),200);}
   if(s.getFailure)return json(res,{error:'Isolated status unavailable'},503);
   return json(res,{enabled:true,configured:s.configured,mode:s.mode,canReceive:s.allowed&&s.configured,task:s.task});
  }
  if(req.method!=='GET'){report.unexpectedRequests.push(req.method+':'+url.pathname);return json(res,{error:'Forbidden isolated write'},405);}
  if(suffix==='/bookmarks')return json(res,{items:[]});
  if(suffix==='')return json(res,{enabled:true,syncConfigured:true,activeRelease:{id:'isolated-'+s.count,sequence:s.count,createdAt:new Date().toISOString()},caseCount:s.count,withdrawalSequence:0,lastSyncAt:null,error:null,searchMode:'keyword-tags',cases:Array.from({length:s.count},(_,i)=>({caseId:match[1]+'-case-'+i,revision:1,title:'隔离案例 '+i,summary:'只验证交互的合成记录',brandOrTeam:'测试',analysisAllowed:false,tags:{},images:[],sources:[],claims:[]}))});
  report.unexpectedRequests.push(url.pathname);return json(res,{error:'Unknown isolated route'},404);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;
}
async function refresh(page){await page.getByRole('button',{name:'刷新状态',exact:true}).click();}
async function disabled(locator){assert.equal(await locator.isDisabled(),true);}
async function enabled(locator){await locator.waitFor();await locator.page().waitForFunction(button=>!button.disabled,await locator.elementHandle());assert.equal(await locator.isEnabled(),true);}
(async()=>{
 const origin=await start();browser=await chromium.launch({executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined),headless:true,args:['--disable-background-networking','--no-proxy-server']});
 for(const spec of [{name:'desktop',width:1440,height:960},{name:'mobile',width:390,height:844}]){
  scenarios.clear();const s=state('receive-a'),b=state('receive-b');
  const context=await browser.newContext({viewport:spec,locale:'zh-CN',serviceWorkers:'block',reducedMotion:'reduce'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
  const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(origin+'/inspiration?workspaceId=receive-a');
  const receive=()=>page.getByRole('button',{name:'接收最新灵感',exact:true});
  await enabled(receive());await refresh(page);assert.equal(s.posts,0);check(spec.name+': refresh is read-only');
  await receive().evaluate(button=>{button.click();button.click();});
  await page.getByRole('button',{name:'接收排队中…'}).waitFor();assert.equal(s.posts,1);check(spec.name+': rapid double click submits once');
  await page.reload();await page.getByRole('button',{name:'接收排队中…'}).waitFor();assert.equal(s.posts,1);check(spec.name+': refresh restores durable pending task');
  s.task={...s.task,status:'RUNNING'};await refresh(page);await page.getByRole('button',{name:'正在接收…'}).waitFor();check(spec.name+': running is server state');
  s.task={...s.task,status:'SUCCEEDED'};s.count=2;await refresh(page);await page.getByText('库内 2 个案例',{exact:true}).waitFor();await enabled(receive());check(spec.name+': completion refreshes catalog');
  s.task=task('FAILED');await refresh(page);await page.getByRole('alert').filter({hasText:'知识包校验未通过'}).waitFor();await enabled(receive());assert.equal(await page.getByTestId('inspiration-case').count(),2);check(spec.name+': failed receipt preserves prior cases');
  s.allowed=false;await refresh(page);await page.getByText('只有当前品牌的所有者可以接收新灵感；已有案例仍可浏览。',{exact:true}).waitFor();await disabled(receive());check(spec.name+': member cannot receive');
  s.allowed=true;s.configured=false;await refresh(page);await page.getByText('接收连接尚未配置，请联系管理员。',{exact:true}).waitFor();await disabled(receive());check(spec.name+': unconfigured receive disabled');
  s.configured=true;s.getFailure=true;await refresh(page);await page.getByRole('button',{name:'重新读取接收状态'}).waitFor();await disabled(receive());check(spec.name+': stale cached permission cannot enable after GET error');
  s.getFailure=false;s.task=null;await page.getByRole('button',{name:'重新读取接收状态'}).click();await enabled(receive());
  s.loseResponse=true;await receive().click();await page.getByRole('button',{name:'接收排队中…'}).waitFor();assert.equal(s.posts,2);await page.getByText('接收请求暂未确认，请查看下方后台状态。请求可能已经受理，系统不会自动重复提交。',{exact:true}).waitFor();check(spec.name+': lost POST response recovers task without retry');
  s.task={...s.task,expiresAt:new Date(Date.now()-1000).toISOString()};await refresh(page);await page.getByRole('alert').filter({hasText:'已超时'}).waitFor();await enabled(receive());check(spec.name+': expired server task has bounded exit');
  s.task=task('RUNNING','old-brand-running');b.allowed=false;await refresh(page);await page.getByRole('button',{name:'正在接收…'}).waitFor();await page.getByTestId('switch-workspace').click();await page.getByText('只有当前品牌的所有者可以接收新灵感；已有案例仍可浏览。',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'正在接收…'}).count(),0);assert.equal(b.posts,0);check(spec.name+': workspace switch clears old receipt state');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);check(spec.name+': no horizontal overflow');
  assert.equal(s.posts,2);await context.close();
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.unexpectedRequests,[]);report.passed=true;
})().catch(error=>{report.errors.push(error.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,errors:report.errors,reportPath}));});

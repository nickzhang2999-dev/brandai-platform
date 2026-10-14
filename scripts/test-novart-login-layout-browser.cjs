/* Actual LoginPage and product tokens, fresh loopback Chromium.
 * Auth providers are a synthetic read-only fixture; this is UI acceptance,
 * not account authentication or provider quality evidence. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');
const repo = path.resolve(__dirname,'..');
const reportPath = process.env.NOVART_LOGIN_LAYOUT_REPORT || path.join(repo,'.novart-build/reports/login-layout-'+Date.now()+'.json');
const temporaryRoot = path.join(repo,'.novart-build/temporary');
fs.mkdirSync(temporaryRoot,{recursive:true});fs.mkdirSync(path.dirname(reportPath),{recursive:true});
const directory = fs.mkdtempSync(path.join(temporaryRoot,'login-layout-'));
const priorTemp = {TEMP:process.env.TEMP,TMP:process.env.TMP};process.env.TEMP=directory;process.env.TMP=directory;
const report = {isolated:true,realAuthentication:false,realBackend:false,realProvider:false,providerCalls:0,scope:'Actual LoginPage React component and product Tailwind tokens with synthetic provider listing',checks:[],errors:[],externalRequests:[],writeRequests:0,passed:false};
let server,browser,stage='bundle';
(async()=>{
  const esbuildPackage=fs.readdirSync(path.join(repo,'node_modules/.pnpm')).find(name=>name.startsWith('esbuild@0.28.'));
  assert.ok(esbuildPackage,'Use installed esbuild without downloading tools');
  const esbuild=require(path.join(repo,'node_modules/.pnpm',esbuildPackage,'node_modules/esbuild'));
  const entry=path.join(directory,'entry.tsx');
  fs.writeFileSync(entry,`import React from 'react';import {createRoot} from 'react-dom/client';import LoginPage from ${JSON.stringify(path.join(repo,'apps/web/src/app/login/page').replaceAll('\\','/'))};createRoot(document.getElementById('root')!).render(<LoginPage/>);`);
  await esbuild.build({entryPoints:[entry],outfile:path.join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},logLevel:'silent'});
  const css=spawnSync(process.execPath,[path.join(repo,'apps/web/node_modules/tailwindcss/lib/cli.js'),'-i',path.join(repo,'packages/ui/src/styles.css'),'-o',path.join(directory,'tokens.css'),'-c',path.join(repo,'apps/web/tailwind.config.ts'),'--content',path.join(repo,'apps/web/src/app/login/page.tsx')+','+path.join(repo,'packages/ui/src/**/*.{ts,tsx}')],{cwd:repo,encoding:'utf8',timeout:60000});
  assert.equal(css.status,0,'Actual product CSS must compile: '+css.stderr);
  const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(!['GET','HEAD'].includes(req.method)){report.writeRequests++;return json(res,{error:'UI test cannot write'},405);}
    if(url.pathname==='/login'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tokens.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}
    if(url.pathname==='/api/auth/providers')return json(res,{password:{id:'password'}});
    if(url.pathname==='/favicon.ico'){res.writeHead(204);return res.end();}
    const file=['/app.js','/tokens.css'].includes(url.pathname)?path.join(directory,url.pathname.slice(1)):url.pathname.startsWith('/brand/')?path.join(repo,'apps/web/public',url.pathname):null;
    if(!file||!fs.existsSync(file))return json(res,{error:'Unknown isolated route'},404);
    res.setHeader('Content-Type',{'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-background-networking','--no-proxy-server']});
  for(const spec of [{name:'desktop-light',width:1440,height:960,fontSize:24},{name:'desktop-dark',width:1440,height:960,fontSize:24,dark:true},{name:'mobile-390',width:390,height:844,fontSize:21}]){
    stage=spec.name;const ctx=await browser.newContext({viewport:{width:spec.width,height:spec.height},locale:'zh-CN',reducedMotion:'reduce'});
    await ctx.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
    const page=await ctx.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>report.errors.push({stage,message:error.message}));
    await page.goto(origin+'/login?callbackUrl=%2Fstudio');await page.getByRole('heading',{name:'进入你的品牌视觉工作台',exact:true}).waitFor();
    if(spec.dark)await page.evaluate(()=>document.documentElement.classList.add('dark'));
    assert.equal(await page.getByRole('heading').count(),1);assert.equal(await page.getByText('登录 DeepFlare',{exact:true}).count(),0);
    const view=await page.getByRole('heading').evaluate(n=>({text:n.textContent,fontSize:parseFloat(getComputedStyle(n).fontSize),align:getComputedStyle(n).textAlign,cardWidth:n.parentElement.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth}));
    assert.equal(view.text,'进入你的品牌视觉工作台');assert.equal(view.fontSize,spec.fontSize);assert.equal(view.align,'center');assert.equal(view.overflow,false);assert.ok(view.cardWidth<=436);
    assert.ok(await page.getByRole('button',{name:'登录',exact:true}).isVisible());assert.ok(await page.getByLabel('邮箱',{exact:true}).isVisible());assert.ok(await page.getByLabel('密码',{exact:true}).isVisible());
    const logo=page.locator(spec.dark?'img[src="/brand/deepflare-logo-dark.svg"]':'img[src="/brand/deepflare-logo.svg"]');assert.ok(await logo.isVisible());assert.ok(await logo.evaluate(n=>n.complete&&n.naturalWidth>0));
    const password=page.getByLabel('密码',{exact:true});assert.equal(await password.getAttribute('autocomplete'),'current-password');assert.equal(await page.getByLabel('邮箱',{exact:true}).getAttribute('autocomplete'),'username');
    await password.fill('Local-visual-123!');await password.focus();await page.getByRole('button',{name:'显示密码',exact:true}).click();assert.equal(await password.getAttribute('type'),'text');assert.equal(await password.inputValue(),'Local-visual-123!');assert.equal(await page.evaluate(()=>document.activeElement.id),'login-password');assert.equal(await page.getByRole('button',{name:'隐藏密码',exact:true}).getAttribute('aria-pressed'),'true');
    await page.getByRole('button',{name:'隐藏密码',exact:true}).focus();await page.keyboard.press('Space');assert.equal(await password.getAttribute('type'),'password');assert.equal(await password.inputValue(),'Local-visual-123!');await page.getByRole('button',{name:'显示密码',exact:true}).click();
    await page.getByRole('button',{name:'没有账号?去注册',exact:true}).click();await page.getByRole('heading',{name:'创建账号',exact:true}).waitFor();assert.ok(await page.getByText('用邮箱开始建立品牌视觉系统（密码至少 8 位）',{exact:true}).isVisible());assert.equal(await password.getAttribute('type'),'password');assert.equal(await password.getAttribute('autocomplete'),'new-password');assert.equal(await password.inputValue(),'Local-visual-123!');await page.getByRole('button',{name:'已有账号?去登录',exact:true}).click();assert.equal(await password.getAttribute('autocomplete'),'current-password');await password.fill('');
    const screenshot=reportPath.replace(/\.json$/,'')+'-'+spec.name+'.png';await page.screenshot({path:screenshot});report.checks.push({name:spec.name,status:'PASS',viewport:spec,view,screenshot});await ctx.close();
  }
  assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);assert.equal(report.writeRequests,0);report.passed=true;
})().catch(error=>{report.fatal={stage,message:error.message,stack:error.stack};process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.writeFileSync(reportPath,JSON.stringify(report,null,2));for(const[name,value]of Object.entries(priorTemp))if(value===undefined)delete process.env[name];else process.env[name]=value;
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(temporaryRoot));fs.rmSync(directory,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,reportPath,fatal:report.fatal,errors:report.errors}));
});

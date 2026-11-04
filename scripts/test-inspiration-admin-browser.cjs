/* Actual administrator React form; isolated HTTP fixtures, never real initialization. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright-core');
const repo=path.resolve(__dirname,'..'),root=path.join(repo,'.novart-build/temporary');fs.mkdirSync(root,{recursive:true});
const dir=fs.mkdtempSync(path.join(root,'inspiration-admin-'));
const reportPath=process.env.NOVART_INSPIRATION_ADMIN_REPORT||path.join(repo,'.novart-build/reports/inspiration-admin-'+Date.now()+'.json');fs.mkdirSync(path.dirname(reportPath),{recursive:true});
const report={isolated:true,realBackend:false,realAuthentication:false,realProvider:false,providerCalls:0,checks:[],errors:[],externalRequests:[],unexpectedRequests:[],passed:false};
const defaults={libraryId:'company-library',activeLibraryId:null,enabled:true,configured:true,initialized:false,conflict:false,boundOwnerId:null,workspaces:[{id:'brand-a',name:'品牌甲',ownerId:'company-a'},{id:'brand-b',name:'品牌乙',ownerId:'company-a'},{id:'brand-c',name:'其他公司',ownerId:'company-b'}]};
let props=defaults,mode='success',posts=[],server,browser;
(async()=>{
 const pkg=fs.readdirSync(path.join(repo,'node_modules/.pnpm')).find(n=>/^esbuild@/.test(n)),esbuild=require(path.join(repo,'node_modules/.pnpm',pkg,'node_modules/esbuild'));
 const entry=path.join(dir,'entry.tsx');fs.writeFileSync(entry,`import React from 'react';import{createRoot}from'react-dom/client';import{LibrarySetupForm}from ${JSON.stringify(path.join(repo,'apps/web/src/app/(admin)/admin/inspiration/LibrarySetupForm.tsx'))};createRoot(document.getElementById('root')!).render(<LibrarySetupForm {...window.setupProps}/>);`);
 await esbuild.build({entryPoints:[entry],outfile:path.join(dir,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],define:{'process.env.NODE_ENV':'"development"','process.env':'{}'},logLevel:'silent'});
 server=http.createServer(async(req,res)=>{
   if(req.url==='/favicon.ico'){res.writeHead(204);return res.end();}
   if(req.url==='/app.js'){res.setHeader('Content-Type','application/javascript');return res.end(fs.readFileSync(path.join(dir,'app.js')));}
   if(req.method==='POST'&&req.url==='/api/admin/inspiration/libraries'){let raw='';for await(const chunk of req)raw+=chunk;posts.push(JSON.parse(raw));await new Promise(r=>setTimeout(r,50));res.writeHead(mode==='success'?201:mode==='denied'?403:502,{'Content-Type':'application/json'});return res.end(JSON.stringify(mode==='success'?{sourceLibrary:{id:'company-library',kind:'SHARED'},created:true}:{error:mode==='denied'?'Admin access required':'Unavailable'}));}
   if(req.method!=='GET'||req.url!=='/'){report.unexpectedRequests.push(req.method+':'+req.url);res.writeHead(404);return res.end();}
   res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<html><body><div id="root"></div><script>window.setupProps='+JSON.stringify(props)+'</script><script src="/app.js"></script></body></html>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':undefined),headless:true,args:['--no-proxy-server']});
 const page=await browser.newPage();page.setDefaultTimeout(5000);page.on('pageerror',e=>report.errors.push(e.message));
 await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){report.externalRequests.push(route.request().url());return route.abort();}return route.continue();});
 const open=async value=>{props={...defaults,...value};await page.goto(origin);};
 const button=()=>page.getByRole('button',{name:'确认初始化共享库'});
 const choose=async()=>{await page.getByRole('combobox').selectOption('brand-a');await page.getByRole('checkbox').check();};
 await open({});assert.equal(await page.getByRole('link',{name:'返回工作台选择品牌并查看灵感库'}).getAttribute('href'),'/studio');assert.equal(await button().isDisabled(),true);await page.getByRole('combobox').selectOption('brand-a');assert.equal(await button().isDisabled(),true);assert.equal(await page.getByRole('listitem').count(),2);await page.getByRole('checkbox').check();await page.getByRole('combobox').selectOption('brand-c');assert.equal(await page.getByRole('checkbox').isChecked(),false);assert.equal(await page.getByRole('listitem').count(),1);report.checks.push('explicit company selection and re-confirmation; only same owner brands covered');
 await choose();await button().evaluate(b=>{b.click();b.click();});await page.getByText(/共享库已初始化。请继续/).waitFor();await page.getByText(/初始化后还需启用/).waitFor();assert.equal(posts.length,1);assert.deepEqual(posts[0],{libraryId:'company-library',ownerId:'company-a',workspaceId:'brand-a'});assert.equal(await button().count(),0);report.checks.push('double click submits once through existing API with workspace ownership evidence');
 await open({libraryId:null});assert.equal(await button().count(),0);await page.getByText(/请先由部署管理员配置/).waitFor();report.checks.push('unconfigured library cannot initialize');
 await open({conflict:true});assert.equal(await button().count(),0);await page.getByRole('alert').waitFor();report.checks.push('conflicting identity cannot be overwritten');
 await open({initialized:true,boundOwnerId:'company-a'});assert.equal(await button().count(),0);assert.equal(await page.getByRole('listitem').count(),2);report.checks.push('initialized library shows scope without repeated submission');
 mode='denied';await open({});await choose();await button().click();await page.getByText('Admin access required',{exact:true}).waitFor();assert.equal(await page.getByText('已初始化',{exact:true}).count(),0);report.checks.push('authorization rejection never reports success');
 mode='lost';await open({});await choose();await button().click();await page.getByText(/请求结果暂未确认/).waitFor();assert.equal(await button().isDisabled(),true);assert.equal(posts.length,3);report.checks.push('uncertain response disables retries until authoritative refresh');
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.unexpectedRequests,[]);report.passed=true;
})().catch(e=>{report.errors.push(e.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(r=>server?server.close(r):r());fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,errors:report.errors,reportPath}));});

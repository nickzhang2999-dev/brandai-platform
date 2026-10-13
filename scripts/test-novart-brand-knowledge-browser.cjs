/* Actual BrandKnowledgeEditor + React Query + product tokens in headless Chromium.
 * Session, membership and persistence below are explicitly synthetic HTTP fixtures.
 * This is browser interaction evidence, NOT SSR/auth/real DB/provider acceptance.
 * No user browser, remote service, model, Docker, account or production data is used. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');
const repo = path.resolve(__dirname, '..');
const temporaryRoot = path.join(repo, '.novart-build', 'temporary');
fs.mkdirSync(temporaryRoot, {recursive:true});
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'knowledge-browser-'));
assert.equal(path.dirname(directory), temporaryRoot);
if (process.platform === 'win32') assert.equal(path.parse(directory).root.toLowerCase(), 'd:\\', 'Browser artifacts must stay on D:');
const reportPath = process.env.NOVART_KNOWLEDGE_REPORT || path.join(repo, '.novart-build', 'reports', `knowledge-browser-${Date.now()}.json`);
if (process.platform === 'win32') assert.equal(path.parse(path.resolve(reportPath)).root.toLowerCase(), 'd:\\', 'Report must stay on D:');
fs.mkdirSync(path.dirname(reportPath), {recursive:true});
const previousTemp = {TEMP:process.env.TEMP, TMP:process.env.TMP};
process.env.TEMP = directory; process.env.TMP = directory;
const report = {isolated:true, realBackend:false, realProvider:false, realAuthentication:false, ssrCovered:false,
  fixtureScope:'Loopback HTTP session/membership and in-memory persistence; actual production React editor and styles',
  providerCalls:0, checks:[], externalRequests:[], errors:[], passed:false};
const fixture = {workspaceId:'knowledge-fixture-a', userId:'knowledge-fixture-user', brandName:'本地合成测试品牌'};
let role = 'EDITOR', stage = 'build', browser, server, page, schemas;
let sequence = 0, draftRevision = 7, loseImportReceipt = true;
const requests = [], writes = [], imports = new Map();
const terms = [], prohibitions = [], snapshots = [];
const date = () => new Date().toISOString();
const clone = value => structuredClone(value);
function rule(type, summary, status='DRAFT') {return {id:`fixture-rule-${++sequence}`,workspaceId:fixture.workspaceId,type,summary,status,strength:'WEAK',value:{},evidence:[],createdAt:date(),updatedAt:date()};}
let rules = [rule('copy','原有已启用中文规则','CONFIRMED'),rule('graphic','已有图形规则草稿')];
const oldConfirmedId = rules[0].id;
function json(res, value, status=200) {res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function body(req) {const chunks=[];for await (const chunk of req) chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');}
function snapshot(label, note) {
  const saved = clone(rules.filter(item=>item.status==='CONFIRMED'));
  const value = {id:`fixture-snapshot-${++sequence}`,workspaceId:fixture.workspaceId,label,note,createdById:fixture.userId,ruleCount:saved.length,createdAt:date(),rules:saved};
  snapshots.unshift(value);return value;
}
function snapshotSummary(value) {const {rules:_rules,...summary}=value;return summary;}
async function handle(req,res) {
  const url = new URL(req.url,'http://127.0.0.1');
  if (url.pathname==='/app.js' || url.pathname==='/tokens.css') {
    res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript':'text/css');return res.end(fs.readFileSync(path.join(directory,url.pathname.slice(1))));
  }
  if (url.pathname.startsWith('/fonts/')) {
    const file=path.resolve(repo,'apps/web/public',url.pathname.slice(1));
    if(file.startsWith(path.join(repo,'apps/web/public/fonts')+path.sep)&&fs.existsSync(file))return res.end(fs.readFileSync(file));
    res.writeHead(404);return res.end();
  }
  if (url.pathname==='/studio-brand-knowledge') {
    res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/tokens.css"><title>Knowledge fixture — not production</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  }
  if(url.pathname==='/favicon.ico') {res.writeHead(204);return res.end();}
  const request = {method:req.method,path:url.pathname,workspaceId:url.searchParams.get('workspaceId')};requests.push(request);
  if (url.pathname==='/api/workbench/session') {
    assert.equal(req.method,'GET');assert.equal(url.searchParams.get('workspaceId'),fixture.workspaceId,'Session URL must pin the explicit fixture workspace');
    return json(res,{user:{id:fixture.userId,name:'合成用户'},activeWorkspaceId:fixture.workspaceId,workspaces:[{id:fixture.workspaceId,name:fixture.brandName,role}]});
  }
  const base=`/api/workspaces/${fixture.workspaceId}`;
  const importRoute=url.pathname==='/api/studio/brand-knowledge/import-draft';
  if(importRoute) {
    assert.equal(url.searchParams.get('workspaceId'),fixture.workspaceId);assert.equal(req.headers['x-novart-user'],fixture.userId);
  } else assert.ok(url.pathname===base || url.pathname.startsWith(base+'/'),'No request may use another workspace');
  const mutating = req.method!=='GET';
  if(mutating && role!=='EDITOR') return json(res,{error:'Synthetic viewer cannot write'},403);
  const value = mutating ? await body(req) : null;
  if(mutating) writes.push({...request,body:clone(value)});
  if(importRoute) {
    if(!mutating) return json(res,schemas.StudioBrandDraftImportState.parse({available:true,draftRevision,importableTypes:['color','font'],hasNotes:true}));
    const input=schemas.StudioBrandDraftImportInput.parse(value), previous=imports.get(input.mutationId);
    if(previous) {assert.deepEqual(previous.input,input);return json(res,{...previous.result,replayed:true});}
    if(input.expectedDraftRevision!==draftRevision) return json(res,{error:'Synthetic stale draft'},409);
    const added=[rule('color','合成草稿颜色'),rule('font','合成草稿字体')];rules.push(...added);
    const result=schemas.StudioBrandDraftImportResult.parse({mutationId:input.mutationId,draftRevision,ruleIds:added.map(item=>item.id),created:2,replayed:false,notesPreserved:true});
    imports.set(input.mutationId,{input,result});
    if(loseImportReceipt) {loseImportReceipt=false;return json(res,{error:'合成故障：导入已处理但回执未收到'},503);}
    return json(res,result);
  }
  const suffix=url.pathname.slice(base.length);
  if(suffix==='') return json(res,{workspace:{id:fixture.workspaceId,name:fixture.brandName,tags:[],createdAt:date(),updatedAt:date()}});
  if(suffix==='/assets') return json(res,[]);
  if(suffix==='/rules/snapshots') {
    if(!mutating)return json(res,{snapshots:snapshots.map(snapshotSummary)});
    const input=schemas.CreateRuleSnapshotInput.parse(value);return json(res,snapshotSummary(snapshot(input.label,input.note)),201);
  }
  const restore=suffix.match(/^\/rules\/snapshots\/([^/]+)\/restore$/);
  if(restore) {
    assert.equal(req.method,'POST');const saved=snapshots.find(item=>item.id===restore[1]);assert.ok(saved);
    const backup=snapshot('恢复前自动备份（fixture）'), ids=new Set(saved.rules.map(item=>item.id));let retired=0;
    rules=rules.map(item=>{if(item.status==='CONFIRMED'&&!ids.has(item.id)){retired++;return {...item,status:'REJECTED'};}return item;});
    for(const item of saved.rules){rules=rules.filter(current=>current.id!==item.id);rules.push(clone(item));}
    return json(res,{restored:saved.rules.length,retired,backupSnapshotId:backup.id});
  }
  if(suffix==='/rules') {
    if(!mutating)return json(res,rules);
    assert.equal(req.method,'POST');schemas.RuleType.parse(value.type);schemas.RuleStrength.parse(value.strength);assert.ok(value.summary.trim());
    const added={...rule(value.type,value.summary),strength:value.strength,value:value.value};schemas.BrandRule.parse(added);rules.push(added);return json(res,added,201);
  }
  const rulePath=suffix.match(/^\/rules\/([^/]+)$/);
  if(rulePath) {
    const current=rules.find(item=>item.id===rulePath[1]);assert.ok(current);
    if(req.method==='DELETE'){rules=rules.filter(item=>item.id!==current.id);return json(res,{ok:true});}
    assert.equal(req.method,'PATCH');const patch=schemas.UpdateRuleInput.parse(value);
    if(patch.status==='CONFIRMED') for(const item of rules)if(item.type===current.type&&item.id!==current.id&&item.status==='CONFIRMED')item.status='REJECTED';
    Object.assign(current,patch,{updatedAt:date()});return json(res,current);
  }
  for(const [kind,items] of [['terms',terms],['prohibitions',prohibitions]]) {
    if(suffix!==`/${kind}`&&!suffix.startsWith(`/${kind}/`))continue;
    const id=suffix.split('/')[2];
    if(!mutating){assert.equal(id,undefined);return json(res,items);}
    const index=id?items.findIndex(item=>item.id===id):-1;
    if(req.method==='DELETE'){assert.ok(index>=0);items.splice(index,1);return json(res,{ok:true});}
    const input=kind==='terms'?schemas.CreateComplianceTermInput.parse({...value,workspaceId:fixture.workspaceId}):schemas.VI.CreateProhibitionRuleInput.parse(value);
    if(id){assert.ok(index>=0);assert.equal(req.method,kind==='terms'?'PUT':'PATCH');Object.assign(items[index],input,{updatedAt:date()});return json(res,items[index]);}
    assert.equal(req.method,'POST');const added={id:`fixture-${kind}-${++sequence}`,workspaceId:fixture.workspaceId,...input,createdAt:date(),updatedAt:date()};items.push(added);return json(res,added,201);
  }
  throw new Error('Unexpected fixture route: '+req.method+' '+url.pathname);
}
function check(name, details={}) {report.checks.push({name,status:'PASS',...details});}
async function settled(predicate) {const deadline=Date.now()+10000;while(!predicate()){assert.ok(Date.now()<deadline,'Synthetic server state did not settle');await new Promise(resolve=>setTimeout(resolve,25));}}
async function mutation(action, method, suffix) {
  const [actual]=await Promise.all([page.waitForResponse(res=>new URL(res.url()).pathname.endsWith(suffix)&&res.request().method()===method),action()]);
  assert.ok(actual.ok(),`Expected successful fixture ${method} ${suffix}, got ${actual.status()}`);return actual.json();
}
async function dialogClick(action, accept, expected) {
  await Promise.all([page.waitForEvent('dialog').then(async dialog=>{assert.match(dialog.message(),expected);await (accept?dialog.accept():dialog.dismiss());}),action()]);
}
function ruleCard(summary) {return page.locator('div.group.relative').filter({has:page.locator('div.mt-1\\.5 > span').filter({hasText:summary})});}
async function ruleMenu(summary) {const card=ruleCard(summary);await card.waitFor();await card.hover();const details=card.locator('details');if(await details.getAttribute('open')===null)await details.locator('summary').click();return details;}

(async()=>{
  const esbuildPackage=fs.readdirSync(path.join(repo,'node_modules/.pnpm')).find(name=>name.startsWith('esbuild@0.28.'));
  assert.ok(esbuildPackage,'Use the already installed build dependency');
  const esbuild=require(path.join(repo,'node_modules/.pnpm',esbuildPackage,'node_modules/esbuild'));
  const modulePath=value=>JSON.stringify(path.join(repo,value).replaceAll('\\','/'));
  const entry=path.join(directory,'entry.tsx');
  fs.writeFileSync(entry,`import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider,useQuery} from '@tanstack/react-query';
import {BrandKnowledgeEditor} from ${modulePath('apps/web/src/components/brand-knowledge/BrandKnowledgeEditor')};
import {apiFetch} from ${modulePath('apps/web/src/lib/client')};
const workspaceId=new URLSearchParams(location.search).get('workspaceId');
function FixtureSessionBoundary(){const session=useQuery({queryKey:['fixture-session',workspaceId],queryFn:()=>apiFetch('/api/workbench/session?'+new URLSearchParams({workspaceId:workspaceId||''}))});if(!session.data)return <p>合成会话读取中</p>;const brand=session.data.workspaces.find(w=>w.id===workspaceId);if(!brand||session.data.activeWorkspaceId!==workspaceId)return <p role="alert">合成会话品牌不匹配</p>;return <BrandKnowledgeEditor wsId={workspaceId} userId={session.data.user.id} brandName={brand.name} role={brand.role} embedded/>;}
const client=new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:false},mutations:{retry:false}}});
createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><FixtureSessionBoundary/></QueryClientProvider>);`);
  await esbuild.build({entryPoints:[entry],outfile:path.join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
  const schemaEntry=path.join(directory,'schemas.ts');fs.writeFileSync(schemaEntry,`export * from ${modulePath('packages/contracts/src/index')};export * from ${modulePath('packages/contracts/src/studio-brand-knowledge')};`);
  await esbuild.build({entryPoints:[schemaEntry],outfile:path.join(directory,'schemas.cjs'),bundle:true,platform:'node',format:'cjs',logLevel:'silent'});schemas=require(path.join(directory,'schemas.cjs'));
  const css=spawnSync(process.execPath,[path.join(repo,'apps/web/node_modules/tailwindcss/lib/cli.js'),'-i',path.join(repo,'packages/ui/src/styles.css'),'-o',path.join(directory,'tokens.css'),'-c',path.join(repo,'apps/web/tailwind.config.ts'),'--content',path.join(repo,'apps/web/src/components/brand-knowledge/*.{ts,tsx}')+','+path.join(repo,'packages/ui/src/**/*.{ts,tsx}')],{cwd:repo,encoding:'utf8',env:{...process.env,TEMP:directory,TMP:directory},timeout:60000});
  assert.equal(css.status,0,'Actual product tokens and utilities must compile');
  report.sourceSha256=Object.fromEntries(['BrandKnowledgeEditor.tsx','DraftImportPanel.tsx','KnowledgeManagementPanels.tsx','knowledge-state.ts'].map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,'apps/web/src/components/brand-knowledge',name))).digest('hex')]));
  server=http.createServer((req,res)=>handle(req,res).catch(error=>{report.errors.push({kind:'fixture-server',message:String(error.message).slice(0,300)});json(res,{error:'Fixture validation failed'},500);}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.NOVART_CHROMIUM_EXECUTABLE?{executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE}:{}),args:['--disable-background-networking'],env:{...process.env,TEMP:directory,TMP:directory}});
  async function newPage() {
    const context=await browser.newContext({viewport:{width:1280,height:960},serviceWorkers:'block'});
    await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin){report.externalRequests.push({protocol:url.protocol,host:url.hostname});return route.abort();}return route.continue();});
    await context.routeWebSocket('**/*',route=>{report.externalRequests.push({protocol:'websocket'});route.close();});
    await context.addCookies([{name:'brandai-active-brand',value:'knowledge-fixture-other',url:origin}]);
    const current=await context.newPage();current.setDefaultTimeout(10000);current.on('pageerror',error=>report.errors.push({kind:'page',name:error.name,message:error.message.slice(0,300)}));return current;
  }
  page=await newPage();const href=origin+'/studio-brand-knowledge?'+new URLSearchParams({workspaceId:fixture.workspaceId,embedded:'1'});
  stage='explicit-brand-and-real-styles';await page.goto(href);await page.getByTestId('brand-knowledge-editor').waitFor();await ruleCard('原有已启用中文规则').waitFor();
  assert.equal(await page.getByTestId('brand-knowledge-editor').getAttribute('data-workspace-id'),fixture.workspaceId);assert.equal(await page.getByRole('textbox',{name:'品牌套件名称',exact:true}).inputValue(),fixture.brandName);
  const styles=await page.getByRole('button',{name:'知识规则',exact:true}).evaluate(element=>({radius:getComputedStyle(element).borderRadius,color:getComputedStyle(element).color}));assert.equal(styles.radius,'9999px');assert.notEqual(styles.color,'rgb(0, 0, 0)');
  assert.equal(writes.length,0);check('explicit-workspace-over-other-cookie-and-product-token-styles',{initialWrites:0});

  stage='chinese-rule-create';const summary='中文规则：用具体事实说明价值，避免夸大。';
  await page.getByRole('button',{name:'手动添加规则',exact:true}).click();await page.getByRole('textbox',{name:'新规则说明',exact:true}).fill(summary);
  const added=await mutation(()=>page.getByRole('button',{name:'保存为草稿',exact:true}).click(),'POST','/rules');await ruleCard(summary).waitFor();assert.equal(added.status,'DRAFT');assert.equal(added.summary,summary);check('editor-creates-chinese-copy-draft');
  stage='cancel-rule-replacement';let menu=await ruleMenu(summary);const beforeCancel=writes.length;
  await dialogClick(()=>menu.getByRole('button',{name:'启用',exact:true}).click(),false,/替换同类别已启用的 1 条规则/);await page.waitForTimeout(150);assert.equal(writes.length,beforeCancel);assert.equal(rules.find(item=>item.id===oldConfirmedId).status,'CONFIRMED');check('replacement-cancel-zero-writes',{writes:0});
  stage='confirm-rule-replacement';menu=await ruleMenu(summary);
  await mutation(()=>dialogClick(()=>menu.getByRole('button',{name:'启用',exact:true}).click(),true,/替换同类别已启用的 1 条规则/),'PATCH','/rules/'+added.id);
  assert.equal(rules.find(item=>item.id===added.id).status,'CONFIRMED');assert.equal(rules.find(item=>item.id===oldConfirmedId).status,'REJECTED');check('explicit-confirm-patches-and-replaces-same-category');
  stage='chinese-rule-edit';menu=await ruleMenu(summary);await menu.getByRole('button',{name:'编辑',exact:true}).click();const editor=page.getByRole('dialog',{name:'编辑文案语气',exact:true});await editor.waitFor();
  const updatedSummary='更新后的中文规则：表达准确、清楚、有依据。';await editor.getByRole('textbox',{name:'规则说明',exact:true}).fill(updatedSummary);await mutation(()=>editor.getByRole('button',{name:'保存',exact:true}).click(),'PATCH','/rules/'+added.id);await ruleCard(updatedSummary).waitFor();check('editor-updates-chinese-rule');
  stage='rule-disable-and-reenable';menu=await ruleMenu(updatedSummary);await mutation(()=>menu.getByRole('button',{name:'禁用',exact:true}).click(),'PATCH','/rules/'+added.id);assert.equal(rules.find(item=>item.id===added.id).status,'REJECTED');menu=await ruleMenu(updatedSummary);await mutation(()=>menu.getByRole('button',{name:'启用',exact:true}).click(),'PATCH','/rules/'+added.id);assert.equal(rules.find(item=>item.id===added.id).status,'CONFIRMED');check('rule-disable-and-reenable');
  stage='graphic-rule-delete';menu=await ruleMenu('已有图形规则草稿');const graphic=rules.find(item=>item.type==='graphic');await mutation(()=>dialogClick(()=>menu.getByRole('button',{name:'删除',exact:true}).click(),true,/不可恢复/),'DELETE','/rules/'+graphic.id);await ruleCard('已有图形规则草稿').waitFor({state:'detached'});check('graphic-rule-delete-with-confirmation');

  stage='snapshot-save';await page.getByRole('button',{name:'版本快照',exact:true}).click();await page.getByRole('textbox',{name:'快照名称',exact:true}).fill('中文规则基线');await page.getByRole('textbox',{name:'快照备注',exact:true}).fill('本机浏览器合成版本');
  const saved=await mutation(()=>page.getByRole('button',{name:'保存当前规则版本',exact:true}).click(),'POST','/rules/snapshots');await page.getByText('中文规则基线 · 1 条规则',{exact:true}).waitFor();assert.equal(saved.ruleCount,1);check('snapshot-save');
  stage='snapshot-restore';await page.getByRole('button',{name:'知识规则',exact:true}).click();menu=await ruleMenu(updatedSummary);await menu.getByRole('button',{name:'编辑',exact:true}).click();await page.getByRole('dialog').getByRole('textbox',{name:'规则说明',exact:true}).fill('需要恢复的临时修改');await mutation(()=>page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click(),'PATCH','/rules/'+added.id);
  await page.getByRole('button',{name:'版本快照',exact:true}).click();const snapshotRow=page.locator('li').filter({hasText:'中文规则基线 · 1 条规则'});
  const restored=await mutation(()=>dialogClick(()=>snapshotRow.getByRole('button',{name:'恢复此版本',exact:true}).click(),true,/恢复前会自动备份/),'POST',`/rules/snapshots/${saved.id}/restore`);assert.equal(restored.restored,1);assert.ok(snapshots.some(item=>item.id===restored.backupSnapshotId));await page.getByRole('button',{name:'知识规则',exact:true}).click();await ruleCard(updatedSummary).waitFor();check('snapshot-restore-refreshes-real-ui-and-reports-backup');

  stage='term-crud';await page.getByRole('button',{name:'禁用项与词库',exact:true}).click();await page.getByRole('textbox',{name:'词条内容',exact:true}).fill('绝对第一');await page.getByRole('textbox',{name:'词条原因',exact:true}).fill('避免无法证明的承诺');await page.getByRole('textbox',{name:'词条替代表达',exact:true}).fill('以实际体验为准');
  const term=await mutation(()=>page.getByRole('button',{name:'添加词条',exact:true}).click(),'POST','/terms');await page.getByText('绝对第一 · 禁用',{exact:true}).waitFor();await page.getByRole('button',{name:'编辑词条',exact:true}).click();await page.getByRole('textbox',{name:'词条内容',exact:true}).fill('百分百保证');await mutation(()=>page.getByRole('button',{name:'保存词条修改',exact:true}).click(),'PUT','/terms/'+term.id);await page.getByText('百分百保证 · 禁用',{exact:true}).waitFor();await mutation(()=>dialogClick(()=>page.getByRole('button',{name:'删除词条',exact:true}).click(),true,/百分百保证/),'DELETE','/terms/'+term.id);await page.getByText('暂无词条。',{exact:true}).waitFor();assert.equal(terms.length,0);check('forbidden-term-chinese-create-edit-delete');
  stage='prohibition-crud';await page.getByRole('textbox',{name:'禁用规范说明',exact:true}).fill('不得拉伸品牌图形');const prohibition=await mutation(()=>page.getByRole('button',{name:'添加禁用规范',exact:true}).click(),'POST','/prohibitions');await page.getByText('不得拉伸品牌图形',{exact:true}).waitFor();assert.equal(prohibition.status,'PENDING');await page.getByRole('button',{name:'编辑规范',exact:true}).click();await page.getByRole('region',{name:'禁用规范',exact:true}).getByRole('combobox',{name:/^状态/}).selectOption('ACTIVE');await mutation(()=>page.getByRole('button',{name:'保存规范修改',exact:true}).click(),'PATCH','/prohibitions/'+prohibition.id);assert.equal(prohibitions[0].status,'ACTIVE');await mutation(()=>dialogClick(()=>page.getByRole('button',{name:'删除规范',exact:true}).click(),true,/不得拉伸/),'DELETE','/prohibitions/'+prohibition.id);await page.getByText('暂无禁用规范。',{exact:true}).waitFor();check('visual-prohibition-create-activate-delete');

  stage='import-uncertain-receipt';await page.getByRole('button',{name:'知识规则',exact:true}).click();const importCount=rules.length;const failedResponse=page.waitForResponse(res=>new URL(res.url()).pathname==='/api/studio/brand-knowledge/import-draft'&&res.request().method()==='POST');await page.getByRole('button',{name:'导入为待确认规则',exact:true}).click();assert.equal((await failedResponse).status(),503);await page.getByText('合成故障：导入已处理但回执未收到',{exact:true}).waitFor();assert.equal(rules.length,importCount+2);draftRevision=8;
  const importWrites=writes.filter(item=>item.path==='/api/studio/brand-knowledge/import-draft');assert.equal(importWrites.length,1);await page.reload();await page.getByRole('button',{name:'重试原导入请求',exact:true}).waitFor();assert.equal(writes.filter(item=>item.path==='/api/studio/brand-knowledge/import-draft').length,1,'Reload must not post automatically');
  const replay=await mutation(()=>page.getByRole('button',{name:'重试原导入请求',exact:true}).click(),'POST','/api/studio/brand-knowledge/import-draft');assert.equal(replay.replayed,true);const allImports=writes.filter(item=>item.path==='/api/studio/brand-knowledge/import-draft');assert.deepEqual(allImports[1].body,allImports[0].body);assert.equal(allImports[1].body.expectedDraftRevision,7);assert.equal(rules.length,importCount+2);assert.equal(rules.find(item=>item.id===added.id).status,'CONFIRMED');check('draft-import-reload-retries-original-mutation-after-revision-change',{postAttempts:2,createdDrafts:2,automaticRetry:false});
  await page.getByText(/已找回原导入回执/).waitFor();await page.screenshot({path:reportPath.replace(/\.json$/i,'')+'-editor.png',fullPage:true});

  stage='viewer-readonly';const beforeViewer=writes.length;role='VIEWER';page=await newPage();await page.goto(href);await ruleCard(updatedSummary).waitFor();assert.equal(await page.getByRole('textbox',{name:'品牌套件名称',exact:true}).getAttribute('readonly'),'');assert.equal(await page.getByRole('checkbox',{name:'应用品牌知识到项目',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'手动添加规则',exact:true}).count(),0);assert.equal(await page.getByText('规则操作',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'导入为待确认规则',exact:true}).isDisabled(),true);
  await ruleCard(updatedSummary).getByRole('button').click();const viewerDialog=page.getByRole('dialog',{name:'查看文案语气',exact:true});await viewerDialog.waitFor();assert.equal(await viewerDialog.getByRole('textbox',{name:'规则说明',exact:true}).getAttribute('readonly'),'');assert.equal(await viewerDialog.getByRole('button',{name:'保存',exact:true}).count(),0);await viewerDialog.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('button',{name:'版本快照',exact:true}).click();await page.getByText('中文规则基线 · 1 条规则',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'保存当前规则版本',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'恢复此版本',exact:true}).count(),0);
  await page.getByRole('button',{name:'禁用项与词库',exact:true}).click();await page.getByText('暂无词条。',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'添加词条',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'添加禁用规范',exact:true}).count(),0);assert.equal(writes.length,beforeViewer);check('viewer-reads-rules-snapshots-terms-without-write-controls',{writes:0});
  stage='scope-and-network';assert.ok(requests.some(item=>item.path==='/api/workbench/session'));assert.ok(requests.every(item=>!item.path.includes('knowledge-fixture-other')&&(!item.workspaceId||item.workspaceId===fixture.workspaceId)));assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);check('all-fixture-requests-stay-in-explicit-workspace-and-loopback');
  report.fixtureRequests=requests.length;report.fixtureWriteRequests=writes.length;report.passed=true;
})().catch(async error=>{
  report.checks.push({name:stage,status:'FAIL'});report.fatal={stage,name:error.name,message:String(error.message).slice(0,800),stack:String(error.stack).slice(0,1400)};process.exitCode=1;
  try{if(page)await page.screenshot({path:reportPath.replace(/\.json$/i,'')+'-failure.png',fullPage:true});}catch{}
}).finally(async()=>{
  try{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));}
  finally{
    fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,reportPath}));
    for(const [key,value] of Object.entries(previousTemp))if(value===undefined)delete process.env[key];else process.env[key]=value;
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(temporaryRoot));fs.rmSync(directory,{recursive:true,force:true});
  }
});

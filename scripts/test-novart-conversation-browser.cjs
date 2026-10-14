/* Production React conversation + API adapter, real pointer/keyboard/refresh in
 * fresh Chromium on loopback. In-memory receipts are INTERACTION fixtures;
 * this does not validate authentication, SQL persistence or model quality. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {chromium} = require('playwright-core');
const repo = path.resolve(__dirname, '..');
const root = path.join(repo, '.novart-build', 'temporary'); fs.mkdirSync(root, {recursive: true});
const directory = fs.mkdtempSync(path.join(root, 'conversation-browser-'));
const packageName = fs.readdirSync(path.join(repo, 'node_modules/.pnpm')).find(name => name.startsWith('esbuild@0.28.'));
const esbuild = require(path.join(repo, 'node_modules/.pnpm', packageName, 'node_modules/esbuild'));
const reportPath = process.env.NOVART_CONVERSATION_REPORT || path.join(repo, '.novart-build', 'conversation-browser-report.json');
const report = {isolated: true, realBackend: false, realProvider: false, realAuthentication: false, providerCalls: 0,
  fixtureScope: 'Actual React conversation and HTTP adapter; synthetic loopback receipts', checks: [], externalRequests: [], errors: []};
let browser, server, contracts, page, stage = 'compile', reject = false, loseResponse = false, delayPut = 0;
let draft = null, postInputs = [], putInputs = [], messages = [], receipts = new Map();
const references = [1, 2].map(number => ({referenceId: `shape:image${number}`, shapeId: `shape:image${number}`, name: `图片${number}`, assetId: `asset${number}`,
  assetSha256: String(number).repeat(64), width: 1080, height: 1920, purpose: 'REFERENCE'}));
const fixture = {workspaceId: 'fixture-workspace', projectId: 'fixture-project', userId: 'fixture-user'};
const check = label => report.checks.push(label);
const json = (res, value, status = 200) => {res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value));};
async function body(req) {const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks));}
async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/app.js') {res.setHeader('Content-Type', 'application/javascript'); return res.end(fs.readFileSync(path.join(directory, 'app.js')));}
  if (url.pathname === '/') {res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><html><head><meta charset="utf-8"><style>body{font:15px system-ui;margin:20px}button{padding:8px;margin:4px}textarea{display:block;width:430px;height:130px}section{width:500px}article{margin:14px 0}fieldset{margin-bottom:12px}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}
  if (url.pathname.endsWith('/studio-conversation')) {
    assert.equal(req.headers['x-novart-user'], fixture.userId);
    if (req.method === 'GET') {const id = url.searchParams.get('messageId'); return json(res, id ? messages.find(row => row.messageId === id) : {messages: [...messages].reverse(), nextCursor: null, draft});}
    const input = await body(req);
    if (req.method === 'PUT') {
      contracts.StudioConversationDraftInput.parse(input); putInputs.push(input);
      if (delayPut) await new Promise(resolve => setTimeout(resolve, delayPut));
      const {revision, ...values} = input;
      if (draft && JSON.stringify({...draft, revision: undefined}) === JSON.stringify({...values, revision: undefined})) return json(res, draft);
      if (revision !== (draft?.revision ?? 0)) return json(res, {error: '另一个标签页更新了草稿'}, 409);
      draft = {...values, revision: revision + 1}; return json(res, draft);
    }
    contracts.StudioConversationInput.parse(input); postInputs.push(input);
    if (reject) return json(res, {error: '只读或权限已变更'}, 403);
    const prior = receipts.get(input.mutationId);
    if (prior) {assert.deepEqual(input, prior.input); return json(res, prior.row, 202);}
    const intent = contracts.parseStudioConversationIntent(input);
    const row = {messageId: 'scm_' + crypto.randomBytes(10).toString('hex'), mutationId: input.mutationId, projectId: fixture.projectId,
      text: input.text, references: input.references, status: intent.action === 'clarify' ? 'CLARIFICATION' : 'SUCCEEDED', intent, generation: null, error: null,
      clarification: intent.clarification, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 360000).toISOString()};
    messages.push(row); receipts.set(input.mutationId, {row, input});
    // A complete 202 header but truncated receipt avoids Chromium's automatic
    // transport replay of a reset reused connection, and reliably exercises
    // the UI's accepted-but-unreadable acknowledgement journal.
    if (loseResponse) {loseResponse = false; res.writeHead(202, {'Content-Type':'application/json'}); return res.end('{"messageId":');}
    return json(res, row, 202);
  }
  return json(res, {error: 'Fixture route missing'}, 404);
}
(async () => {
  const absolute = file => path.join(repo, file).replaceAll('\\', '/');
  const entry = path.join(directory, 'entry.tsx');
  fs.writeFileSync(entry, `import React,{useRef,useState} from '${absolute('apps/web/node_modules/react')}';
import {createRoot} from '${absolute('apps/web/node_modules/react-dom/client')}';
import {OwnedConversationPanel} from '${absolute('apps/web/src/components/owned-canvas/OwnedConversationPanel')}';
const refs=${JSON.stringify(references)};const readOnly=new URL(location.href).searchParams.has('readonly');
function Fixture(){const panel=useRef<any>(null),[selected,setSelected]=useState<any[]>([]),[notice,setNotice]=useState('');
 const run=(fn:any)=>{try{Promise.resolve(fn()).catch(e=>setNotice(e.message))}catch(e:any){setNotice(e.message)}};
 return <><fieldset><legend>交互测试夹具 · 非业务验收</legend><button onClick={()=>setSelected([refs[0]])}>选择图片1</button><button onClick={()=>setSelected([refs[1],refs[0]])}>选择图片2和1</button><button onClick={()=>run(()=>panel.current.addReferences(selected))}>加入当前选择</button><button onClick={()=>run(()=>panel.current.addReferences([refs[1]],refs[1].referenceId))}>固定快捷目标图片2</button><button onClick={()=>run(async()=>{await panel.current.flush();setNotice('离页草稿已确认')} )}>模拟品牌离页保存</button><p role="status">{notice}</p></fieldset>
 <OwnedConversationPanel ref={panel} {...${JSON.stringify(fixture)}} readOnly={readOnly} api={null} prepare={async()=>({documentRevision:1,workflowRevision:0})} onNotice={setNotice} onGeneration={()=>{}} onInsert={async()=>{}} onInsertLayers={async()=>{}} /></>}
createRoot(document.getElementById('root')!).render(<Fixture/>);`);
  await esbuild.build({entryPoints:[entry],outfile:path.join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
  fs.writeFileSync(path.join(directory, 'schemas.ts'), `export {StudioConversationInput,StudioConversationDraftInput} from '${absolute('packages/contracts/src/studio-conversation')}';export {parseStudioConversationIntent} from '${absolute('apps/web/src/lib/studio-conversation-intent')}';`);
  await esbuild.build({entryPoints:[path.join(directory,'schemas.ts')],outfile:path.join(directory,'schemas.cjs'),bundle:true,platform:'node',format:'cjs',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],logLevel:'silent'}); contracts = require(path.join(directory, 'schemas.cjs'));
  server = http.createServer((req,res)=>handle(req,res).catch(error=>{report.errors.push('fixture:' + error.message);json(res,{error:'Fixture handler error'},500);}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless:true,...(process.env.NOVART_CHROMIUM_EXECUTABLE ? {executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE}:{}),args:['--disable-background-networking']});
  const context = await browser.newContext({viewport:{width:1100,height:900}});
  await context.route('**/*',route=>{const url = new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==origin){report.externalRequests.push(url.hostname);return route.abort();}return route.continue();});
  page = await context.newPage(); page.on('pageerror',error=>report.errors.push(error.message));
  const button = name => page.getByRole('button',{name,exact:true}); const input = () => page.getByRole('textbox',{name:'对话设计需求',exact:true});
  const ready = () => page.waitForFunction(()=>document.querySelector('[data-testid="owned-conversation"]')?.dataset.conversationReady==='true');
  const saved = () => page.waitForFunction(()=>document.querySelector('[data-testid="owned-conversation"]')?.textContent?.includes('对话草稿已保存'));
  stage = 'explicit-ordered-refs'; await page.goto(origin); await ready(); await button('选择图片2和1').click();
  assert.equal(await page.getByRole('button',{name:/移除对话引用/}).count(),0); check('selection-alone-does-not-change-conversation-references');
  await button('加入当前选择').click(); await saved(); assert.deepEqual(draft.references.map(ref=>ref.assetId),['asset2','asset1']);
  await button('加入当前选择').click(); assert.equal(await page.getByRole('button',{name:/移除对话引用/}).count(),2); check('explicit-add-keeps-order-and-deduplicates');
  stage = 'draft-restore'; await input().fill('还没有写完的海报需求'); await saved(); await page.reload(); await ready();
  assert.equal(await input().inputValue(),'还没有写完的海报需求'); assert.equal(await page.getByRole('button',{name:/移除对话引用/}).count(),2);check('server-draft-and-ordered-references-restore-after-refresh');
  stage = 'ime'; const beforeIme=postInputs.length; await input().dispatchEvent('compositionstart'); await input().fill('把背景改成蓝色'); await input().press('Enter');
  assert.equal(postInputs.length,beforeIme); await input().dispatchEvent('compositionend'); check('chinese-composition-enter-never-sends');
  await button('发送').click(); await page.getByText('你引用了多张图片：要合成一张新图，还是修改其中一张？请写明图片名称。',{exact:true}).waitFor();check('ambiguous-multi-image-request-renders-server-clarification');
  stage = 'quick-target'; await button('固定快捷目标图片2').click(); await input().fill('生成一张夜景海报'); await button('发送').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-message-id]').length===2); assert.equal(messages.at(-1).intent.action,'modify');assert.equal(messages.at(-1).intent.targetReferenceId,references[1].referenceId);check('quick-edit-freezes-explicit-target-even-with-new-image-language');
  stage = 'lost-response'; loseResponse=true; await input().fill('图片2背景改成浅色'); const priorCount=messages.length; await button('发送').click();
  await button('确认原请求回执').waitFor(); assert.equal(messages.length,priorCount+1); const frozen=postInputs.at(-1); assert.equal(await input().isDisabled(),true);
  await button('加入当前选择').click(); assert.equal(await page.getByRole('button',{name:/移除对话引用/}).count(),2);check('lost-acceptance-response-freezes-input-and-image-snapshot');
  await button('确认原请求回执').click(); await button('确认原请求回执').waitFor({state:'hidden'});assert.equal(messages.length,priorCount+1);assert.equal(postInputs.at(-1).mutationId,frozen.mutationId);assert.deepEqual(postInputs.at(-1).references,frozen.references);check('unknown-receipt-replay-reuses-mutation-without-second-job');
  stage = 'history'; await saved(); await page.reload(); await ready(); assert.equal(await page.locator('[data-message-id]').count(),messages.length);check('history-survives-client-refresh');
  stage = 'explicit-refusal'; reject=true; await input().fill('图片2背景改成绿色');await button('发送').click();await page.getByRole('alert').filter({hasText:'只读或权限已变更'}).waitFor();
  assert.equal(await input().isDisabled(),false);assert.equal(await button('确认原请求回执').count(),0);reject=false;await input().fill('修正后的需求');check('definite-403-rejection-unlocks-input-and-clears-unaccepted-journal');
  stage = 'cross-tab-conflict'; await button('确认草稿').click(); await saved(); draft={...draft,revision:draft.revision+1,text:'另一个标签页保存了需求'}; const beforeConflict=postInputs.length;
  await input().fill('这份本地需求必须保留');await button('发送').click();await page.getByRole('alert').filter({hasText:/草稿/}).waitFor();assert.equal(postInputs.length,beforeConflict);assert.equal(await input().inputValue(),'这份本地需求必须保留');check('draft-revision-conflict-preserves-input-and-prevents-send');
  stage = 'leave-flush'; await page.reload();await ready();await input().fill('离开品牌前保存');await button('模拟品牌离页保存').click();await page.getByRole('status').filter({hasText:'离页草稿已确认'}).waitFor();assert.equal(draft.text,'离开品牌前保存');check('brand-leave-flush-waits-for-server-draft-acknowledgement');
  stage = 'readonly'; await page.goto(origin+'/?readonly=1');await ready();const beforeReadonly=postInputs.length;assert.equal(await input().isDisabled(),true);assert.equal(await button('发送').isDisabled(),true);await button('固定快捷目标图片2').click();assert.equal(postInputs.length,beforeReadonly);check('read-only-conversation-cannot-submit-or-retarget');
  assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;report.messagePosts=postInputs.length;report.uniqueAcceptedMessages=messages.length;report.draftWrites=putInputs.length;
})().catch(async error=>{report.fatal={stage,message:error.message,stack:error.stack};report.diagnostics={draft,postCount:postInputs.length,putCount:putInputs.length,body:await page?.locator('body').innerText().catch(()=>null)};process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(root));fs.rmSync(directory,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,reportPath,fatal:report.fatal,errors:report.errors}));
});

/* Production React conversation + API adapter, real pointer/keyboard/refresh in
 * fresh Chromium on loopback. In-memory receipts are INTERACTION fixtures;
 * this does not validate authentication, SQL persistence or model quality. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');
const repo = path.resolve(__dirname, '..');
const root = path.join(repo, '.novart-build', 'temporary'); fs.mkdirSync(root, {recursive: true});
const directory = fs.mkdtempSync(path.join(root, 'conversation-browser-'));
const packageName = fs.readdirSync(path.join(repo, 'node_modules/.pnpm')).find(name => name.startsWith('esbuild@0.28.'));
const esbuild = require(path.join(repo, 'node_modules/.pnpm', packageName, 'node_modules/esbuild'));
const reportPath = process.env.NOVART_CONVERSATION_REPORT || path.join(repo, '.novart-build', 'conversation-browser-report.json');
const report = {isolated: true, realBackend: false, realProvider: false, realAuthentication: false, providerCalls: 0,
  fixtureScope: 'Actual React conversation and HTTP adapter; synthetic loopback receipts', checks: [], terminalStateEvidence: [], externalRequests: [], errors: []};
let browser, server, contracts, page, stage = 'compile', reject = false, loseResponse = false, delayPut = 0;
let draft = null, postInputs = [], putInputs = [], messages = [], receipts = new Map(), decisions = new Map();
let archiveRetries = [], generationPosts = 0, retryRelease = null, delayRetry = false;
let delayedMessageRead = null, messageReadRelease = null;
const messageReads = new Map();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf6EAAAAASUVORK5CYII=', 'base64');
const references = [1, 2].map(number => ({referenceId: `shape:image${number}`, shapeId: `shape:image${number}`, name: `图片${number}`, assetId: `asset${number}`,
  assetSha256: String(number).repeat(64), width: 1080, height: 1920, purpose: 'REFERENCE'}));
const fixture = {workspaceId: 'fixture-workspace', projectId: 'fixture-project', userId: 'fixture-user'};
const check = label => report.checks.push(label);
const json = (res, value, status = 200) => {res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value));};
async function body(req) {const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks));}
async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/app.js') {res.setHeader('Content-Type', 'application/javascript'); return res.end(fs.readFileSync(path.join(directory, 'app.js')));}
  if (url.pathname === '/app.css') {res.setHeader('Content-Type','text/css');return res.end(fs.readFileSync(path.join(directory,'tokens.css')));}
  if (url.pathname === '/') {res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>body{margin:12px}fieldset{font-size:12px;max-width:800px}fieldset button{padding:4px;margin:2px;border:1px solid var(--border);border-radius:8px}.fixture-panel{width:min(360px,100%);height:calc(100dvh - 200px);padding:16px;border:1px solid var(--border);border-radius:24px;min-height:320px}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}
  if (new RegExp(`^/api/workspaces/${fixture.workspaceId}/assets/(fixture-result|asset[12])/raw$`).test(url.pathname) && req.method === 'GET') {res.setHeader('Content-Type', 'image/png'); return res.end(png);}
  if (url.pathname === '/studio/generation/retry-archive' && req.method === 'POST') {
    assert.equal(req.headers['x-novart-user'], fixture.userId); assert.equal(url.searchParams.get('workspaceId'), fixture.workspaceId);
    const input = contracts.StudioGenerationArchiveRetryInput.parse(await body(req)); assert.equal(input.projectId, fixture.projectId);
    const row = messages.find(value => value.generation?.requestId === input.requestId); assert.ok(row); assert.equal(row.generation.canRetryArchive, true);
    archiveRetries.push(input);
    const task = contracts.StudioGenerationView.parse({...row.generation, resultState: 'PENDING', archiveError: null, canRetryArchive: false, archiveProcessingExpiresAt:new Date(Date.now()+360000).toISOString()});
    if (delayRetry) await new Promise(resolve => {retryRelease = resolve;});
    return json(res, task, 202);
  }
  if (url.pathname === '/studio/generation' && req.method === 'POST') {generationPosts++; return json(res, {error: 'No provider is configured in this interaction fixture'}, 424);}
  if (url.pathname.endsWith('/studio-conversation')) {
    assert.equal(req.headers['x-novart-user'], fixture.userId);
    if (url.pathname.includes('/projects/fixture-other-project/')) {assert.equal(req.method,'GET');await new Promise(resolve=>setTimeout(resolve,600));return json(res,{messages:[],nextCursor:null,draft:null});}
    if (req.method === 'GET') {
      const id = url.searchParams.get('messageId'); if (id) messageReads.set(id, (messageReads.get(id) ?? 0) + 1);
      const snapshot = structuredClone(id ? messages.find(row => row.messageId === id) : {messages: [...messages].reverse(), nextCursor: null, draft});
      if (id && id === delayedMessageRead) {delayedMessageRead = null; await new Promise(resolve => {messageReadRelease = resolve;});}
      return json(res, snapshot);
    }
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
    let intent = contracts.parseStudioConversationIntent(input);
    if(input.decision) {
      const choiceKey=input.decision.sourceMessageId, existing=decisions.get(choiceKey);
      if(existing) {
        if(existing.input.decision.kind!==input.decision.kind || existing.input.decision.optionId!==input.decision.optionId) return json(res,{error:'这条消息已经选择了其他操作，请查看原任务结果。'},409);
        return json(res,existing.row,202);
      }
      const source=messages.find(message=>message.messageId===choiceKey); assert.ok(source?.originalInput);
      const option=(input.decision.kind==='clarification'?source.intent.options:source.intent.correctionOptions).find(option=>option.id===input.decision.optionId);assert.ok(option);
      for(const key of ['text','references','sizeSelection','quickEditTargetId','psdLayerMode','psdLayerCount','requestedSize'])assert.deepEqual(input[key],source.originalInput[key]);
      intent={...source.intent,action:option.action,targetReferenceId:option.targetReferenceId,referenceIds:option.referenceIds,imagePrompt:option.imagePrompt,clarification:null,options:[],correctionOptions:[]};
    }
    const row = {messageId: 'scm_' + crypto.randomBytes(10).toString('hex'), mutationId: input.mutationId, projectId: fixture.projectId,
      text: input.text, references: input.references, originalInput:input, status: intent.action === 'clarify' ? 'CLARIFICATION' : 'SUCCEEDED', intent, generation: null, error: null,
      clarification: intent.clarification, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 360000).toISOString()};
    messages.push(row); receipts.set(input.mutationId, {row, input}); if(input.decision)decisions.set(input.decision.sourceMessageId,{row,input});
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
  fs.writeFileSync(entry, `import React,{useRef,useState,useMemo} from '${absolute('apps/web/node_modules/react')}';
import {createRoot} from '${absolute('apps/web/node_modules/react-dom/client')}';
import {OwnedConversationPanel} from '${absolute('apps/web/src/components/owned-canvas/OwnedConversationPanel')}';
import {createOwnedEditorApi} from '${absolute('apps/web/src/components/owned-canvas/owned-editor-api')}';
const refs=${JSON.stringify(references)};const readOnly=new URL(location.href).searchParams.has('readonly');
function Fixture(){const panel=useRef<any>(null),[selected,setSelected]=useState<any[]>([]),[notice,setNotice]=useState(''),[projectId,setProjectId]=useState('${fixture.projectId}');
 const ownedApi=useMemo(()=>createOwnedEditorApi('${fixture.workspaceId}',projectId,'${fixture.userId}'),[projectId]);
 const run=(fn:any)=>{try{Promise.resolve(fn()).catch(e=>setNotice(e.message))}catch(e:any){setNotice(e.message)}};
 return <><fieldset><legend>交互测试夹具 · 非业务验收</legend><button onClick={()=>setSelected([refs[0]])}>选择图片1</button><button onClick={()=>setSelected([refs[1],refs[0]])}>选择图片2和1</button><button onClick={()=>run(()=>panel.current.addReferences(selected))}>加入当前选择</button><button onClick={()=>run(()=>panel.current.addReferences([refs[1]],refs[1].referenceId))}>固定快捷目标图片2</button><button onClick={()=>run(async()=>{await panel.current.flush();setNotice('离页草稿已确认')} )}>模拟品牌离页保存</button><p role="status">{notice}</p></fieldset>
 <button onClick={()=>setProjectId('fixture-other-project')}>切换另一个项目</button><button onClick={()=>run(()=>panel.current.startHome('首页生成一张海报','605a9288-8aae-4ccd-8ced-99c05e32b2bd',[Object.fromEntries(Object.entries(refs[0]).reverse())]))}>首页开始创作</button><button onClick={()=>run(()=>panel.current.quickEdit(refs[0],'后来的快捷编辑不应篡改原请求'))}>直接快捷修改图片1</button>
 <div className="fixture-panel"><OwnedConversationPanel ref={panel} {...${JSON.stringify(fixture)}} projectId={projectId} readOnly={readOnly} api={ownedApi} prepare={async()=>{(window as any).__conversationPrepareCalls=((window as any).__conversationPrepareCalls||0)+1;return {documentRevision:1,workflowRevision:0}}} selectedReferenceIds={references=>references.filter(ref=>selected.some(value=>value.shapeId===ref.shapeId)).map(ref=>ref.referenceId)} onNotice={setNotice} onGeneration={()=>{}} onInsert={async()=>{}} onInsertLayers={async()=>{}} /></div></>}
createRoot(document.getElementById('root')!).render(<Fixture/>);`);
  await esbuild.build({entryPoints:[entry],outfile:path.join(directory,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
  fs.writeFileSync(path.join(directory, 'schemas.ts'), `export {StudioConversationInput,StudioConversationDraftInput,StudioConversationMessage} from '${absolute('packages/contracts/src/studio-conversation')}';export {StudioGenerationView,StudioGenerationArchiveRetryInput} from '${absolute('packages/contracts/src/studio-generation')}';export {parseStudioConversationIntent} from '${absolute('apps/web/src/lib/studio-conversation-intent')}';`);
  await esbuild.build({entryPoints:[path.join(directory,'schemas.ts')],outfile:path.join(directory,'schemas.cjs'),bundle:true,platform:'node',format:'cjs',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],logLevel:'silent'}); contracts = require(path.join(directory, 'schemas.cjs'));
  const css=spawnSync(process.execPath,[path.join(repo,'apps/web/node_modules/tailwindcss/lib/cli.js'),'-i',path.join(repo,'packages/ui/src/styles.css'),'-o',path.join(directory,'tokens.css'),'-c',path.join(repo,'apps/web/tailwind.config.ts'),'--content',path.join(repo,'apps/web/src/components/owned-canvas/*.{ts,tsx}')],{cwd:repo,encoding:'utf8',timeout:60000});
  assert.equal(css.status,0,'Actual product styles must compile');
  server = http.createServer((req,res)=>handle(req,res).catch(error=>{report.errors.push('fixture:' + error.message);json(res,{error:'Fixture handler error'},500);}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless:true,...(process.env.NOVART_CHROMIUM_EXECUTABLE ? {executablePath:process.env.NOVART_CHROMIUM_EXECUTABLE}:{}),args:['--disable-background-networking']});
  const context = await browser.newContext({viewport:{width:1100,height:900}});
  await context.route('**/*',route=>{const url = new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==origin){report.externalRequests.push(url.hostname);return route.abort();}return route.continue();});
  page = await context.newPage(); page.on('pageerror',error=>report.errors.push(error.message));
  const button = name => page.getByRole('button',{name,exact:true}); const input = () => page.getByRole('textbox',{name:'对话设计需求',exact:true});
  const ready = () => page.waitForFunction(()=>document.querySelector('[data-testid="owned-conversation"]')?.dataset.conversationReady==='true');
  const saved = () => page.waitForFunction(()=>document.querySelector('[data-testid="conversation-draft-status"]')?.dataset.saved==='true');
  stage = 'explicit-ordered-refs'; await page.goto(origin); await ready(); await button('选择图片2和1').click();
  assert.equal(await page.getByRole('button',{name:/移除对话引用/}).count(),0); check('selection-alone-does-not-change-conversation-references');
  await button('加入当前选择').click(); await saved(); assert.deepEqual(draft.references.map(ref=>ref.assetId),['asset2','asset1']);
  await button('加入当前选择').click(); assert.equal(await page.getByRole('button',{name:/移除对话引用/}).count(),2); check('explicit-add-keeps-order-and-deduplicates');
  stage = 'draft-restore'; await input().fill('还没有写完的海报需求'); await saved(); await page.reload(); await ready();
  assert.equal(await input().inputValue(),'还没有写完的海报需求'); assert.equal(await page.getByRole('button',{name:/移除对话引用/}).count(),2);check('server-draft-and-ordered-references-restore-after-refresh');
  stage = 'real-dirty-page-unload'; const beforeUnloadPosts=postInputs.length, beforeUnloadRevision=draft.revision;
  const acceptLeave=dialog=>dialog.accept();page.on('dialog',acceptLeave);
  await input().fill('刚输入就离开：最后一段中文必须保存');
  assert.equal(await page.getByTestId('conversation-draft-status').getAttribute('data-saved'),'false');
  await page.goto('about:blank');
  await until(()=>draft.text==='刚输入就离开：最后一段中文必须保存');
  assert.equal(draft.revision,beforeUnloadRevision+1);assert.equal(postInputs.length,beforeUnloadPosts);
  await page.goto(origin);await ready();await saved();page.off('dialog',acceptLeave);
  assert.equal(await input().inputValue(),'刚输入就离开：最后一段中文必须保存');assert.deepEqual(draft.references.map(ref=>ref.assetId),['asset2','asset1']);
  check('actual-dirty-page-navigation-saves-latest-conversation-without-generation');
  stage = 'ime'; const beforeIme=postInputs.length; await input().dispatchEvent('compositionstart'); await input().fill('把背景改成蓝色'); await input().press('Enter');
  assert.equal(postInputs.length,beforeIme); await input().dispatchEvent('compositionend'); check('chinese-composition-enter-never-sends');
  await button('发送').click(); await page.getByText('你引用了多张图片：要合成一张新图，还是修改其中一张？请写明图片名称。',{exact:true}).waitFor();check('ambiguous-multi-image-request-renders-server-clarification');
  stage='clarification-actions-preserve-explicit-send';const clarifyPosts=postInputs.length;
  await input().fill('另一份尚未发送的需求');await button('参考生成新图').click();assert.equal(await input().inputValue(),'另一份尚未发送的需求');assert.equal(postInputs.length,clarifyPosts);
  await input().fill('');await button('参考生成新图').click();await saved();assert.equal(await input().inputValue(),'生成一张新图：把背景改成蓝色');assert.equal(postInputs.length,clarifyPosts);assert.equal(draft.quickEditTargetId,null);
  check('clarification-choice-preserves-other-draft-and-never-auto-submits');
  stage = 'quick-target'; await button('固定快捷目标图片2').click(); await input().fill('生成一张夜景海报'); await button('发送').click();
  await page.waitForFunction(()=>document.querySelectorAll('[data-message-id]').length===2); assert.equal(messages.at(-1).intent.action,'modify');assert.equal(messages.at(-1).intent.targetReferenceId,references[1].referenceId);check('quick-edit-freezes-explicit-target-even-with-new-image-language');
  stage = 'lost-response'; loseResponse=true; await input().fill('图片2背景改成浅色'); const priorCount=messages.length; await button('发送').click();
  await button('检查上次提交').waitFor(); assert.equal(messages.length,priorCount+1); const frozen=postInputs.at(-1); assert.equal(await input().isDisabled(),true);
  await button('加入当前选择').click(); assert.equal(await page.getByRole('button',{name:/移除对话引用/}).count(),2);check('lost-acceptance-response-freezes-input-and-image-snapshot');
  await button('检查上次提交').click(); await button('检查上次提交').waitFor({state:'hidden'});assert.equal(messages.length,priorCount+1);assert.equal(postInputs.at(-1).mutationId,frozen.mutationId);assert.deepEqual(postInputs.at(-1).references,frozen.references);check('unknown-receipt-replay-reuses-mutation-without-second-job');
  stage = 'history'; await saved(); await page.reload(); await ready(); assert.equal(await page.locator('[data-message-id]').count(),messages.length);check('history-survives-client-refresh');
  stage = 'explicit-refusal'; reject=true; await input().fill('图片2背景改成绿色');await button('发送').click();await page.getByRole('alert').filter({hasText:'只读或权限已变更'}).waitFor();
  assert.equal(await input().isDisabled(),false);assert.equal(await button('检查上次提交').count(),0);reject=false;await input().fill('修正后的需求');check('definite-403-rejection-unlocks-input-and-clears-unaccepted-journal');
  stage = 'cross-tab-conflict'; await button('确认草稿').click(); await saved(); draft={...draft,revision:draft.revision+1,text:'另一个标签页保存了需求'}; const beforeConflict=postInputs.length;
  await input().fill('这份本地需求必须保留');await button('发送').click();await page.getByRole('alert').filter({hasText:/草稿/}).waitFor();assert.equal(postInputs.length,beforeConflict);assert.equal(await input().inputValue(),'这份本地需求必须保留');check('draft-revision-conflict-preserves-input-and-prevents-send');
  stage = 'leave-flush'; await page.reload();await ready();await input().fill('离开品牌前保存');await button('模拟品牌离页保存').click();await page.getByRole('status').filter({hasText:'离页草稿已确认'}).waitFor();assert.equal(draft.text,'离开品牌前保存');check('brand-leave-flush-waits-for-server-draft-acknowledgement');
  stage = 'readonly'; await page.goto(origin+'/?readonly=1');await ready();const beforeReadonly=postInputs.length;assert.equal(await input().isDisabled(),true);assert.equal(await button('发送').isDisabled(),true);await button('固定快捷目标图片2').click();assert.equal(postInputs.length,beforeReadonly);check('read-only-conversation-cannot-submit-or-retarget');
  report.uniqueAcceptedMessages=messages.length;
  stage = 'error-notice-not-paid'; await page.goto(origin);await ready();await button('固定快捷目标图片2').click();
  const errorNotice='修改目标已失效、归属不符或原始配方发生变化，请重新选择图片。';await input().fill(errorNotice);await button('发送').click();
  await page.getByText(/不会据此发起新的模型调用/).waitFor();assert.equal(messages.at(-1).status,'CLARIFICATION');assert.equal(messages.at(-1).generation,null);
  assert.equal(await input().isDisabled(),false);const beforeNextEdit=messages.length;await input().fill('把背景改成蓝色');await button('发送').click();
  await page.waitForFunction(count=>document.querySelectorAll('[data-message-id]').length===count,beforeNextEdit+1);
  assert.equal(messages.at(-1).intent.action,'modify');assert.equal(messages.at(-1).intent.targetReferenceId,references[1].referenceId);
  check('pasted-error-notice-clarifies-without-generation-and-next-explicit-edit-still-works');

  const expiry = () => new Date(Date.now()+360000).toISOString();
  const task = (overrides = {}) => contracts.StudioGenerationView.parse({mode:'generate',psdLayerCount:null,psdLayerMode:null,
    requestId:'terminal-request',mutationId:'4b4d8b34-4c61-4561-8abf-2b2746f07177',projectId:fixture.projectId,generationId:'terminal-generation',
    status:'RUNNING',progress:null,expiresAt:expiry(),archiveExpiresAt:null,archiveProcessingExpiresAt:null,displayText:'终态回归夹具',
    resultState:'NOT_REQUESTED',results:[],error:null,archiveError:null,canRetryArchive:false,...overrides});
  const row = (generation, overrides = {}) => contracts.StudioConversationMessage.parse({messageId:'terminal-message',
    mutationId:'4b4d8b34-4c61-4561-8abf-2b2746f07177',projectId:fixture.projectId,text:'明确生成请求',references:[],status:'RUNNING',
    intent:null,generation,error:null,clarification:null,createdAt:new Date().toISOString(),expiresAt:expiry(),...overrides});
  const result = {versionId:'fixture-version',assetId:'fixture-result',assetSha256:crypto.createHash('sha256').update(png).digest('hex'),
    width:1,height:1,mimeType:'image/png',url:`/api/workspaces/${fixture.workspaceId}/assets/fixture-result/raw`};
  const show = async rows => {messages=rows;draft=null;messageReads.clear();await page.goto(origin);await ready();};
  const activity = () => page.getByText(/^(正在创作…|生成完成，正在保存图片)$/);
  const pollCount = id => messageReads.get(id)??0;
  async function until(condition) {const end=Date.now()+7000;while(!condition()){assert.ok(Date.now()<end,'Expected conversation poll did not arrive');await new Promise(resolve=>setTimeout(resolve,50));}}
  const quiet = async (scenario, ids) => {const before=ids.map(pollCount);await page.waitForTimeout(4100);assert.deepEqual(ids.map(pollCount),before);report.terminalStateEvidence.push({scenario,messagePolls:ids.map((id,index)=>({messageId:id,before:before[index],after:pollCount(id)}))});};

  stage = 'failed-terminal';const failed=task({status:'FAILED',error:'夹具模型失败，未生成图片'});
  await show([row(failed,{status:'FAILED',error:'夹具模型失败，未生成图片'}),row(task({...failed,requestId:'stale-request',generationId:'stale-generation'}),{messageId:'stale-running-message',status:'RUNNING',text:'过时顶层状态仍然运行'})]);
  assert.equal(await activity().count(),0);assert.equal(await input().isDisabled(),false);assert.equal(await page.getByRole('alert').filter({hasText:'本次生成未完成'}).count(),2);
  await quiet('FAILED / NOT_REQUESTED wins over failed and stale RUNNING messages',['terminal-message','stale-running-message']);
  check('generation-failure-with-not-requested-archive-stops-progress-and-all-repeat-polls');

  stage = 'running-polls';await show([row(task())]);await activity().waitFor();await until(()=>pollCount('terminal-message')>=1);
  check('normal-running-generation-renders-progress-and-continues-read-only-poll');
  stage = 'success-archive-pending';messages=[row(task({status:'SUCCEEDED',resultState:'PENDING'}),{status:'SUCCEEDED'})];
  const beforeArchive=pollCount('terminal-message');await until(()=>pollCount('terminal-message')>beforeArchive);await activity().waitFor();
  check('successful-generation-with-pending-archive-remains-active');
  stage = 'ready-stops';messages=[row(task({status:'SUCCEEDED',resultState:'READY',results:[result]}),{status:'SUCCEEDED'})];
  await page.getByText('图片已生成并保存',{exact:true}).waitFor({timeout:7000});assert.equal(await activity().count(),0);
  await quiet('RUNNING -> SUCCEEDED / PENDING -> READY stops subsequent polls',['terminal-message']);
  check('poll-transition-to-ready-stops-progress-and-further-polling');

  stage = 'explicit-archive-retry';const archiveFailed=task({status:'SUCCEEDED',resultState:'FAILED',archiveError:'夹具保存失败',canRetryArchive:true});
  await show([row(archiveFailed,{status:'FAILED',error:'夹具保存失败'})]);assert.equal(await activity().count(),0);
  const retriesBefore=archiveRetries.length;await button('重试保存结果').click();await activity().waitFor();
  assert.equal(archiveRetries.length,retriesBefore+1);assert.equal(await page.getByRole('alert').filter({hasText:'夹具保存失败'}).count(),0);assert.equal(generationPosts,0);
  messages=[row(task({status:'SUCCEEDED',resultState:'READY',results:[result]}),{status:'SUCCEEDED'})];
  await page.getByText('图片已生成并保存',{exact:true}).waitFor({timeout:7000});await quiet('Explicit archive retry clears stale failure and stops after READY',['terminal-message']);
  check('explicit-archive-retry-clears-stale-message-error-and-never-resubmits-generation');

  stage = 'stale-retry-response';await show([row(archiveFailed,{status:'FAILED',error:'夹具保存失败'})]);delayRetry=true;
  await button('重试保存结果').click();await until(()=>!!retryRelease);
  messages=[row(task({status:'SUCCEEDED',resultState:'READY',results:[result]}),{status:'SUCCEEDED',text:'最新会话内容必须保留'})];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByText('最新会话内容必须保留',{exact:true}).waitFor();await page.getByText('图片已生成并保存',{exact:true}).waitFor();
  const release=retryRelease;retryRelease=null;delayRetry=false;release();await button('重试保存结果').waitFor({state:'hidden'});
  await page.getByRole('status').filter({hasText:'已重新保存生成结果，不会再次生成图片。'}).waitFor();
  assert.equal(await page.getByText('最新会话内容必须保留',{exact:true}).count(),1);assert.equal(await activity().count(),0);assert.equal(await page.getByRole('alert').filter({hasText:'夹具保存失败'}).count(),0);
  await quiet('Late retry PENDING uses latest message and cannot regress READY',['terminal-message']);
  check('late-archive-retry-response-preserves-latest-message-metadata-and-ready-state');

  stage = 'ready-stale-top-level';await show([row(task({status:'SUCCEEDED',resultState:'READY',results:[result]}),{status:'RUNNING'})]);
  await page.getByText('图片已生成并保存',{exact:true}).waitFor();assert.equal(await activity().count(),0);
  await quiet('READY wins over stale RUNNING top-level status',['terminal-message']);
  check('ready-result-overrides-stale-running-message-without-progress-or-repeat-polls');

  stage = 'stale-poll-after-list';delayedMessageRead='terminal-message';await show([row(task())]);await until(()=>!!messageReadRelease);
  messages=[row(task({status:'SUCCEEDED',resultState:'READY',results:[result]}),{status:'SUCCEEDED',text:'最新读取已经保存'})];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByText('图片已生成并保存',{exact:true}).waitFor();
  const releaseRead=messageReadRelease;messageReadRelease=null;releaseRead();await page.waitForTimeout(250);
  assert.equal(await activity().count(),0);assert.equal(await page.getByText('最新读取已经保存',{exact:true}).count(),1);
  await quiet('Earlier poll cannot replace newer list READY receipt',['terminal-message']);
  check('late-poll-does-not-regress-newer-manual-read-or-message-metadata');

  stage='new-authoritative-revocation';messages=[row(task({status:'SUCCEEDED',resultState:'FAILED',archiveError:'图片已由服务端撤销',results:[]}),{status:'FAILED',error:'图片已由服务端撤销'})];
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByRole('alert').filter({hasText:'图片已由服务端撤销'}).waitFor();
  assert.equal(await page.getByText('图片已生成并保存',{exact:true}).count(),0);
  check('later-authoritative-read-can-revoke-ready-results-without-permanent-client-freeze');

  stage = 'expired-message-active-archive';const past=new Date(Date.now()-1000).toISOString();
  await show([row(task({status:'SUCCEEDED',resultState:'PENDING',expiresAt:past,archiveExpiresAt:expiry(),archiveProcessingExpiresAt:expiry()}),{status:'SUCCEEDED',expiresAt:past})]);
  await activity().waitFor();await until(()=>pollCount('terminal-message')>=1);
  messages=[row(task({status:'SUCCEEDED',resultState:'READY',results:[result]}),{status:'SUCCEEDED',expiresAt:past})];
  await page.getByText('图片已生成并保存',{exact:true}).waitFor({timeout:7000});
  check('archive-processing-deadline-keeps-polling-after-original-message-expired');

  stage = 'expired-archive-explicit-retry';await show([row(task({...archiveFailed,expiresAt:past}),{status:'FAILED',error:'夹具保存失败',expiresAt:past})]);
  await button('重试保存结果').click();await activity().waitFor();await until(()=>pollCount('terminal-message')>=1);
  messages=[row(task({status:'SUCCEEDED',resultState:'READY',results:[result]}),{status:'SUCCEEDED',expiresAt:past})];await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.getByText('图片已生成并保存',{exact:true}).waitFor();
  check('explicit-archive-retry-resumes-polling-with-new-lease-after-message-expiry');

  stage = 'quick-edit-during-send';await show([]);const postsBeforeQuick=postInputs.length,putsBeforeQuick=putInputs.length;delayPut=800;
  await input().fill('生成一张需要保留的原始海报需求');await button('发送').click();await until(()=>putInputs.length>putsBeforeQuick);
  await button('直接快捷修改图片1').click();await page.getByRole('status').filter({hasText:'请先确认对话已恢复和上一份请求。'}).waitFor();
  await until(()=>postInputs.length>postsBeforeQuick);delayPut=0;assert.equal(postInputs.length,postsBeforeQuick+1);
  assert.equal(postInputs.at(-1).text,'生成一张需要保留的原始海报需求');assert.equal(postInputs.at(-1).quickEditTargetId,null);
  check('quick-edit-during-inflight-send-cannot-replace-frozen-user-prompt-or-target');

  stage='home-accepted-receipt-restores-without-repost';await show([]);loseResponse=true;const homePosts=postInputs.length;
  await button('首页开始创作').click();await button('检查上次提交').waitFor();assert.equal(postInputs.length,homePosts+1);assert.equal(postInputs.at(-1).homeStart,true);assert.equal(messages.length,1);
  await page.reload();await ready();assert.equal(await page.locator('[data-message-id]').count(),1);await button('首页开始创作').click();await button('检查上次提交').waitFor({state:'hidden'});assert.equal(postInputs.length,homePosts+1);
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),'deepflare:conversation-pending:'+JSON.stringify([fixture.userId,fixture.workspaceId,fixture.projectId])),null);
  check('home-start-lost-receipt-confirms-reordered-reference-keys-from-history-without-second-post');

  stage = 'composer-target-choice';await show([]);await button('选择图片2和1').click();await button('加入当前选择').click();await saved();
  const targetChoice=(number=1)=>page.getByRole('button',{name:`修改对象 图片${number}`,exact:true});
  assert.equal(await targetChoice().getAttribute('aria-pressed'),'false');assert.equal(draft.quickEditTargetId,null);
  check('adding-references-does-not-silently-pin-an-edit-target');
  await targetChoice().click();await input().fill('光影自然一点，阳光洒下');await saved();
  await page.reload();await ready();assert.equal(await targetChoice().getAttribute('aria-pressed'),'true');
  assert.equal(await input().getAttribute('placeholder'),'描述这张图片要怎么修改');
  check('explicit-composer-target-restores-from-server-draft-after-refresh');
  const targetPosts=postInputs.length;await button('发送').click();await until(()=>postInputs.length>targetPosts);await saved();
  assert.equal(messages.at(-1).intent.action,'modify');assert.equal(messages.at(-1).intent.targetReferenceId,references[0].referenceId);
  assert.deepEqual(messages.at(-1).intent.referenceIds,[references[1].referenceId]);
  check('natural-language-with-explicit-target-modifies-one-image-and-retains-other-references');
  await targetChoice(2).click();await saved();await button('移除对话引用 图片2').click();await saved();
  assert.equal(await targetChoice().getAttribute('aria-pressed'),'false');assert.equal(draft.quickEditTargetId,null);
  check('removing-the-selected-reference-clears-the-persisted-edit-target');
  await input().fill('构图保持不变，场景真实一点，阳光洒下来');const naturalPosts=postInputs.length;
  await button('发送').click();await until(()=>postInputs.length>naturalPosts);await saved();
  assert.equal(messages.at(-1).intent.action,'modify');assert.equal(messages.at(-1).intent.targetReferenceId,references[0].referenceId);
  check('single-image-natural-adjustment-no-longer-produces-generic-clarification');
  await targetChoice().click();await saved();await targetChoice().click();await saved();
  assert.equal(draft.quickEditTargetId,null);await input().fill('参考图片1，生成一张海报');const newPosts=postInputs.length;
  await button('发送').click();await until(()=>postInputs.length>newPosts);await saved();assert.equal(messages.at(-1).intent.action,'generate');
  check('cancel-target-allows-new-generation-without-reusing-old-edit-target');
  await targetChoice().click();await saved();await page.goto(origin+'/?readonly=1');await ready();
  assert.equal(await targetChoice().isDisabled(),true);await page.goto(origin);await ready();
  check('persisted-target-selector-is-disabled-for-read-only-projects');

  stage = 'minimal-controls';await show([]);
  assert.equal(await page.getByRole('combobox',{name:'对话图片比例'}).isVisible(),false);
  await page.getByLabel('生成设置',{exact:true}).click();await page.getByRole('combobox',{name:'对话图片比例'}).selectOption('16:9');await saved();
  await page.getByLabel('生成设置',{exact:true}).click();await page.reload();await ready();
  await page.getByLabel('生成设置',{exact:true}).click();assert.equal(await page.getByRole('combobox',{name:'对话图片比例'}).inputValue(),'16:9');
  check('collapsed-settings-remain-editable-and-persist-after-refresh');
  stage='psd-options-persist-and-send';await page.getByRole('checkbox',{name:'同时准备可编辑PSD',exact:true}).check();await page.getByRole('combobox',{name:'PSD分层方式',exact:true}).selectOption('MANUAL');await page.getByRole('spinbutton',{name:'PSD图层数量',exact:true}).fill('6');await saved();
  await page.reload();await ready();await page.getByLabel('生成设置',{exact:true}).click();assert.equal(await page.getByRole('checkbox',{name:'同时准备可编辑PSD',exact:true}).isChecked(),true);assert.equal(await page.getByRole('combobox',{name:'PSD分层方式',exact:true}).inputValue(),'MANUAL');assert.equal(await page.getByRole('spinbutton',{name:'PSD图层数量',exact:true}).inputValue(),'6');
  await page.getByLabel('生成设置',{exact:true}).click();await input().fill('生成一张星空海报');const beforePsd=postInputs.length;await button('发送').click();await until(()=>postInputs.length>beforePsd);await saved();assert.equal(postInputs.at(-1).psdLayerMode,'MANUAL');assert.equal(postInputs.at(-1).psdLayerCount,6);assert.equal(generationPosts,0);
  check('manual-psd-options-restore-and-travel-with-one-conversation-request');
  stage = 'failure-reedit';
  const recoverIntent=contracts.parseStudioConversationIntent({text:'加一个角色在最前面',references,quickEditTargetId:references[1].referenceId,sizeSelection:{ratioKey:'3:4',resolutionTier:'2K'}});
  const recoverRow=row(task({status:'FAILED',mode:'modify',error:'生成服务暂时异常，本次请求未完成。系统不会自动重新生成；请稍后检查任务结果。'}),{status:'FAILED',text:'加一个角色在最前面',references,intent:recoverIntent});
  await show([recoverRow]);const recoverPosts=postInputs.length;
  assert.equal(await page.locator('[data-task-id] h3').count(),0);
  await button('重新编辑').click();await saved();assert.equal(postInputs.length,recoverPosts);assert.equal(await input().inputValue(),recoverRow.text);
  assert.deepEqual(draft.references,references);assert.equal(draft.quickEditTargetId,references[1].referenceId);assert.equal(draft.sizeSelection.resolutionTier,'2K');
  check('failure-reedit-restores-prompt-references-target-and-size-without-submitting');
  await input().fill('新需求不能覆盖');await saved();await button('重新编辑').click();assert.equal(await input().inputValue(),'新需求不能覆盖');assert.equal(postInputs.length,recoverPosts);
  check('failure-reedit-preserves-an-unsent-draft');
  await page.goto(origin+'/?readonly=1');await ready();assert.equal(await button('重新编辑').isDisabled(),true);assert.equal(postInputs.length,recoverPosts);
  check('read-only-failure-cannot-restore-or-submit-a-request');
  await show([row(task({status:'SUCCEEDED',resultState:'READY',results:[result]}),{status:'SUCCEEDED'})]);
  assert.equal(await button('恢复到画布').isVisible(),true);assert.equal(await button('读取品牌检查').isVisible(),false);
  await page.getByText('品牌检查',{exact:true}).click();assert.equal(await button('读取品牌检查').isVisible(),true);
  check('compact-result-hides-secondary-controls-without-removing-them');

  stage='structured-r2-clarification';
  const frozenInput=contracts.StudioConversationInput.parse({mutationId:crypto.randomUUID(),text:'用这两张图做一个春日方案',references,quickEditTargetId:null,sizeSelection:{ratioKey:'3:4',resolutionTier:'2K'},requestedSize:{width:1200,height:1600},documentRevision:4,workflowRevision:3,psdLayerMode:'MANUAL',psdLayerCount:4});
  const modelOptions=[{id:'generate-spring',label:'用两张图创作海报',action:'generate',targetReferenceId:null,referenceIds:references.map(ref=>ref.referenceId),imagePrompt:'以两张参考图为视觉参考，设计春日海报'},
    {id:'modify-first',label:'只修改第一张图片',action:'modify',targetReferenceId:references[0].referenceId,referenceIds:[references[1].referenceId],imagePrompt:'保持第一张构图，以第二张配色调整春日氛围'}];
  const modelIntent={action:'clarify',targetReferenceId:null,referenceIds:[],prompt:frozenInput.text,clarification:'你希望怎样使用这两张图片？',requestedSize:frozenInput.requestedSize,sizeSource:'control',sizeSelection:frozenInput.sizeSelection,parser:'structured-model-v2',modelStatus:'SUCCEEDED',options:modelOptions};
  const modelRow=row(null,{messageId:'model-options-message',mutationId:frozenInput.mutationId,text:frozenInput.text,references,originalInput:frozenInput,status:'CLARIFICATION',intent:modelIntent,clarification:modelIntent.clarification});
  await show([modelRow]);await button('选择图片1').click();await input().fill('另一个未发送草稿必须保留');await saved();
  const decisionPosts=postInputs.length;await page.waitForTimeout(150);assert.equal(postInputs.length,decisionPosts);
  await button('只修改第一张图片').click();await until(()=>postInputs.length===decisionPosts+1);await button('发送').waitFor();await until(()=>messages.length===2);
  const decisionInput=postInputs.at(-1);assert.notEqual(decisionInput.mutationId,frozenInput.mutationId);assert.deepEqual(decisionInput.decision,{sourceMessageId:modelRow.messageId,optionId:'modify-first',kind:'clarification'});
  assert.deepEqual(decisionInput.references,references);assert.equal(decisionInput.text,frozenInput.text);assert.deepEqual(decisionInput.sizeSelection,frozenInput.sizeSelection);assert.equal(decisionInput.psdLayerCount,4);assert.deepEqual(decisionInput.selectedReferenceIds,[references[0].referenceId]);
  assert.equal(await input().inputValue(),'另一个未发送草稿必须保留');assert.ok(await page.evaluate(()=>window.__conversationPrepareCalls)>0);
  await page.locator('[data-message-id]').last().getByText('实际生成描述',{exact:true}).click();assert.equal(await page.getByText(modelOptions[1].imagePrompt,{exact:true}).isVisible(),true);
  check('structured-choice-explicitly-submits-original-input-after-save-with-real-selection-and-keeps-unsent-draft');
  const repeated=postInputs.length, acceptedCount=messages.length;await button('只修改第一张图片').click();await until(()=>postInputs.length===repeated+1);await page.waitForTimeout(120);
  assert.equal(messages.length,acceptedCount);assert.equal(await button('检查上次提交').count(),0);assert.equal(await input().isEnabled(),true);check('same-structured-choice-accepts-prior-child-despite-new-mutation-without-second-job');
  await button('用两张图创作海报').click();await page.getByRole('alert').filter({hasText:'这条消息已经选择了其他操作'}).waitFor();assert.equal(messages.length,acceptedCount);assert.equal(await input().isEnabled(),true);check('different-second-choice-is-definitively-rejected-with-draft-preserved');

  stage='structured-r2-correction';
  const completedRow=row(task({status:'SUCCEEDED',resultState:'READY',results:[result]}),{messageId:'model-result-message',mutationId:frozenInput.mutationId,text:frozenInput.text,references,originalInput:frozenInput,status:'SUCCEEDED',intent:{...modelIntent,action:'generate',clarification:null,options:[],correctionOptions:[modelOptions[1]],imagePrompt:'实际已经使用的春日生成描述'},clarification:null});
  await show([completedRow]);const correctionPosts=postInputs.length;await page.getByText('判断错了',{exact:true}).click();await page.getByText(/会重新生成并消耗额度/).waitFor();assert.equal(postInputs.length,correctionPosts);
  await input().fill('修正判断也不能覆盖新草稿');await saved();await button('只修改第一张图片').click();await until(()=>postInputs.length===correctionPosts+1);assert.equal(postInputs.at(-1).decision.kind,'correction');assert.equal(await input().inputValue(),'修正判断也不能覆盖新草稿');check('correction-discloses-cost-and-needs-explicit-choice-before-one-new-request');
  await show([{...completedRow,intent:{...completedRow.intent,modelStatus:'UNKNOWN',options:modelOptions},status:'CLARIFICATION'}]);assert.equal(await page.getByTestId('conversation-correction-options').count(),0);assert.equal(await page.getByTestId('conversation-clarification-options').count(),0);assert.equal(await button('参考生成新图').count(),0);assert.equal(await button('只修改第一张图片').count(),0);check('unknown-model-result-never-offers-paid-clarification-or-correction');
  await show([{...completedRow,status:'RUNNING',generation:task()}]);assert.equal(await page.getByTestId('conversation-correction-options').count(),0);check('running-generation-never-offers-paid-correction');
  await show([{...modelRow,originalInput:undefined}]);assert.equal(await button('只修改第一张图片').count(),0);await page.getByText(/这条历史需求缺少原始设置/).waitFor();check('historical-options-without-frozen-input-do-not-guess-current-draft-settings');
  await show([modelRow]);await page.goto(origin+'/?readonly=1');await ready();assert.equal(await button('只修改第一张图片').isDisabled(),true);check('read-only-structured-choice-remains-disabled');

  stage='structured-choice-lost-response';
  await show([{...modelRow,messageId:'lost-choice-message'}]);await input().fill('选择丢回复也保留当前草稿');await saved();loseResponse=true;const choiceUnknownPosts=postInputs.length;
  await button('只修改第一张图片').click();await button('检查上次提交').waitFor();const unknownChoice=postInputs.at(-1), choiceAcceptedCount=messages.length;
  assert.equal(unknownChoice.decision.sourceMessageId,'lost-choice-message');assert.equal(await button('用两张图创作海报').isDisabled(),true);
  await button('检查上次提交').click();await button('检查上次提交').waitFor({state:'hidden'});assert.equal(postInputs.length,choiceUnknownPosts+2);assert.equal(postInputs.at(-1).mutationId,unknownChoice.mutationId);assert.equal(messages.length,choiceAcceptedCount);assert.equal(await input().inputValue(),'选择丢回复也保留当前草稿');
  check('lost-structured-choice-replays-exact-mutation-on-explicit-check-without-erasing-composer');

  stage='responsive-composer';await show([recoverRow]);await button('重新编辑').click();await saved();
  for (const viewport of [{width:1100,height:900},{width:390,height:740},{width:1100,height:600}]) {
    await page.setViewportSize(viewport);
    const metrics=await page.evaluate(()=>{const panel=document.querySelector('[data-testid="owned-conversation"]'),field=panel.querySelector('textarea'),history=panel.querySelector('[aria-label="项目对话记录"]');return {panel:panel.getBoundingClientRect().toJSON(),field:field.getBoundingClientRect().toJSON(),scrollWidth:panel.scrollWidth,width:panel.clientWidth,historyOverflow:getComputedStyle(history).overflowY};});
    assert.ok(metrics.scrollWidth<=metrics.width+1,'Panel must not overflow horizontally');assert.ok(metrics.field.bottom<=metrics.panel.bottom+1,'Composer must stay inside panel');assert.equal(metrics.historyOverflow,'auto');
    await page.getByLabel('生成设置',{exact:true}).click();const settings=await page.getByRole('combobox',{name:'对话图片比例'}).boundingBox();assert.ok(settings.x>=0 && settings.x+settings.width<=viewport.width,'Settings stay within viewport');await page.getByLabel('生成设置',{exact:true}).click();
  }
  await page.setViewportSize({width:1100,height:900});
  if(process.env.NOVART_CONVERSATION_SCREENSHOT) await page.locator('.fixture-panel').screenshot({path:process.env.NOVART_CONVERSATION_SCREENSHOT});
  check('composer-and-settings-fit-desktop-mobile-and-short-window');

  stage = 'switch-project-with-poll';delayedMessageRead='terminal-message';await show([row(task())]);
  await button('固定快捷目标图片2').click();await saved();assert.equal(await targetChoice(2).getAttribute('aria-pressed'),'true');
  await input().fill('旧项目草稿不能出现在新项目');await saved();await until(()=>!!messageReadRelease);await button('切换另一个项目').click();
  await page.waitForFunction(()=>document.querySelector('[data-testid="owned-conversation"]')?.dataset.conversationReady==='false');
  await page.waitForTimeout(250);assert.equal(await input().inputValue(),'');assert.equal(await page.getByRole('alert').count(),0);
  const releaseOldProject=messageReadRelease;messageReadRelease=null;releaseOldProject();await ready();await page.waitForTimeout(250);
  assert.equal(await page.locator('[data-message-id]').count(),0);assert.equal(await page.getByRole('alert').count(),0);
  assert.equal(await targetChoice().count(),0);
  check('project-switch-clears-old-draft-and-ignores-aborted-poll-errors-and-receipts');
  assert.equal(generationPosts,0);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);
  report.passed=true;report.messagePosts=postInputs.length;report.draftWrites=putInputs.length;report.archiveRetries=archiveRetries.length;report.directGenerationPosts=generationPosts;
})().catch(async error=>{report.fatal={stage,message:error.message,stack:error.stack};report.diagnostics={draft,postCount:postInputs.length,putCount:putInputs.length,body:await page?.locator('body').innerText().catch(()=>null)};process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(root));fs.rmSync(directory,{recursive:true,force:true});console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,reportPath,fatal:report.fatal,errors:report.errors}));
});

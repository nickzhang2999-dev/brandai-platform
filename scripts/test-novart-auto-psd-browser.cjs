/* Real production React editor and authenticated API adapter against a bounded
 * loopback HTTP fixture. Synthetic PNGs verify interaction/PSD packaging only;
 * no model, account, production database or existing user browser is touched. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');
const repo = path.resolve(__dirname, '..');
const temporaryRoot = path.join(repo, '.novart-build', 'temporary');
fs.mkdirSync(temporaryRoot, {recursive: true});
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'auto-psd-browser-'));
const esbuildPackage = fs.readdirSync(path.join(repo, 'node_modules/.pnpm')).find(value => value.startsWith('esbuild@0.28.'));
assert.ok(esbuildPackage, 'Use installed esbuild without downloading tools');
const esbuild = require(path.join(repo, 'node_modules/.pnpm', esbuildPackage, 'node_modules/esbuild'));
const psdCodec = require(path.join(repo, 'apps/web/node_modules/ag-psd'));
const fixture = {workspaceId: 'fixture-workspace', projectId: 'fixture-project', userId: 'fixture-user'};
const report = {isolated: true, realBackend: false, realProvider: false, realAuthentication: false, providerCalls: 0,
  fixtureScope: 'Loopback in-memory server receipts; actual production React editor and API; synthetic RGBA layers',
  checks: [], externalRequests: [], errors: [], originalImagePreserved: false, selectionRestored: false, download: null};
let stage = 'build-fixture', browser, server, contracts;
let canvas = '', revision = 0, writes = 0, generationPosts = 0, decompositionPosts = 0, exportReads = 0;
let denyExport = true, psdFailure = false;
let draft = {projectId: fixture.projectId, revision: 0, inputForm: null, updatedAt: null, referenceIssues: []};
let conversationDraft = null;
let workflow = {projectId: fixture.projectId, revision: 0, mode: 'generate', target: null, references: [], updatedAt: null, issues: []};
const generations = [], generationInputs = [], psdReads = [], decompositions = new Map();
function pngChunk(type, value) {
  const payload = Buffer.concat([Buffer.from(type), value]), result = Buffer.alloc(value.length + 12); let crc = 0xffffffff;
  for (const byte of payload) {crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);}
  result.writeUInt32BE(value.length); payload.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
}
function imageBytes(pixel) {
  const header = Buffer.alloc(13); header.writeUInt32BE(12, 0); header.writeUInt32BE(8, 4); header[8] = 8; header[9] = 6;
  const rgba = Buffer.alloc(8 * 49), pixels = new Uint8ClampedArray(12 * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) {const color = pixel(x, y); Buffer.from(color).copy(rgba, y * 49 + 1 + x * 4); pixels.set(color, (y * 12 + x) * 4);}
  return {png: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(rgba)), pngChunk('IEND', Buffer.alloc(0))]), pixels};
}
const foreground = (x, y) => x >= 3 && x < 7 && y >= 2 && y < 5 ? [220, 70, 90, 255] : [0, 0, 0, 0];
const original = imageBytes((x, y) => foreground(x, y)[3] ? foreground(x, y) : [124, 92, 255, 255]);
const layers = [imageBytes(() => [124, 92, 255, 255]), imageBytes(foreground)];
const assetSha256 = crypto.createHash('sha256').update(original.png).digest('hex');
const material = {id: 'fixture-original', assetId: 'fixture-original', assetSha256, width: 12, height: 8, mimeType: 'image/png', sizeBytes: original.png.length,
  fileName: '合成交互样例.png', kind: 'image', url: `/api/workspaces/${fixture.workspaceId}/assets/fixture-original/raw`};
const sourceShapeId = 'shape:generated-' + crypto.createHash('sha256').update(material.assetId).digest('hex').slice(0, 40);
const layerResults = layers.map((layer, order) => ({order, assetId: 'fixture-layer-' + order, assetSha256: crypto.createHash('sha256').update(layer.png).digest('hex'), mimeType: 'image/png', sizeBytes: layer.png.length,
  width: 12, height: 8, url: `/api/workspaces/${fixture.workspaceId}/assets/fixture-layer-${order}/raw`, alphaBounds: order ? {left: 3, top: 2, width: 4, height: 3} : {left: 0, top: 0, width: 12, height: 8}, inkCoverage: order ? 12 / 96 : 1}));
const refinements = [0, 1].map(order => imageBytes((x, y) => (order === 0 ? x < 5 : x >= 5) ? foreground(x, y) : [0, 0, 0, 0]));
const refinedResults = refinements.map((layer, order) => ({...layerResults[1], order, assetId: 'fixture-refined-' + order,
  assetSha256: crypto.createHash('sha256').update(layer.png).digest('hex'), sizeBytes: layer.png.length,
  url: `/api/workspaces/${fixture.workspaceId}/assets/fixture-refined-${order}/raw`, alphaBounds: {left: 3 + order * 2, top: 2, width: 2, height: 3}, inkCoverage: 6 / 96}));
const refinementInputs = [], refinementTasks = [];
const psd = Buffer.from(psdCodec.writePsd({width: 12, height: 8, children: layers.map((layer, order) => ({name: '合成图层 ' + (order + 1), left: 0, top: 0, opacity: 1,
  imageData: {width: 12, height: 8, data: layer.pixels}})).reverse(), imageData: {width: 12, height: 8, data: original.pixels}}, {noBackground: true, trimImageData: false, generateThumbnail: false}));
const check = name => report.checks.push(name);
const json = (res, value, status = 200) => {res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(value));};
async function body(req) {const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString());}
const records = () => canvas ? JSON.parse(zlib.gunzipSync(Buffer.from(canvas.slice('SHAKKERDATA://'.length), 'base64'))).tldrawSnapshot.document.store : {};
const shapes = () => Object.values(records()).filter(value => value.typeName === 'shape');
const documentView = () => ({workspaceId: fixture.workspaceId, projectId: fixture.projectId, format: 'novart-native-v1', canvas, revision, checksum: canvas ? crypto.createHash('sha256').update(canvas).digest('hex') : null, updatedAt: revision ? new Date().toISOString() : null, readOnly: false});
const assets = () => contracts.workflowAssets(fixture.projectId, canvas, generations.length ? [{sha256: assetSha256, url: material.url, mimeType: material.mimeType}] : []);
function createGeneration(input) {
      generationPosts++; generationInputs.push(input);
      const requestId = 'fixture-generation-' + generationPosts;
      const value = contracts.StudioGenerationView.parse({requestId, projectId: fixture.projectId, mode: 'generate', generationId: 'fixture-g-' + generationPosts, mutationId: input.mutationId,
        status: 'SUCCEEDED', progress: null, expiresAt: new Date(Date.now() + 360000).toISOString(), archiveExpiresAt: null, archiveProcessingExpiresAt: null,
        displayText: input.prompt, resultState: 'READY', results: [{versionId: 'fixture-version-' + generationPosts, assetId: material.assetId, assetSha256, width: 12, height: 8, mimeType: 'image/png', url: material.url}],
        error: null, archiveError: null, canRetryArchive: false, psdLayerMode: input.psdLayerMode ?? (input.psdLayerCount ? 'MANUAL' : null), psdLayerCount: input.psdLayerCount ?? null}); generations.unshift(value);
      if (input.psdLayerMode || input.psdLayerCount) decompositions.set(requestId, {reads: 0, fail: psdFailure, value: contracts.StudioDecompositionView.parse({requestId: 'fixture-decomposition-' + generationPosts, projectId: fixture.projectId, mutationId: input.mutationId,
        sourceShapeId, assetId: material.assetId, assetSha256, sourceWidth: 12, sourceHeight: 8, documentRevision: input.documentRevision, layerCount: input.psdLayerCount ?? 2, layerMode: input.psdLayerMode ?? 'MANUAL', analysisStatus: input.psdLayerMode === 'AUTO' ? 'PENDING' : 'NOT_REQUESTED', analysisSummary: null, status: 'PENDING', error: null,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 360000).toISOString(), archiveExpiresAt: null, canRetryArchive: false, layers: []})});
  return value;
}
const messages=[];
async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (/^\/brand\/deepflare-(?:logo(?:-dark)?|mark|icon)\.svg$/.test(url.pathname)) {res.setHeader('content-type', 'image/svg+xml'); return res.end(fs.readFileSync(path.join(repo, 'apps/web/public', url.pathname)));}
  if (['/app.js', '/app.css'].includes(url.pathname)) {res.setHeader('content-type', url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css'); return res.end(url.pathname.endsWith('.css') ? Buffer.concat([fs.readFileSync(path.join(directory, 'tokens.css')), fs.readFileSync(path.join(directory, 'app.css'))]) : fs.readFileSync(path.join(directory, 'app.js')));}
  if (url.pathname.startsWith('/fonts/')) {const file = path.resolve(repo, 'apps/web/public', url.pathname.slice(1)); if (file.startsWith(path.join(repo, 'apps/web/public/fonts') + path.sep) && fs.existsSync(file)) return res.end(fs.readFileSync(file)); res.writeHead(404); return res.end();}
  if (url.pathname === '/') {res.setHeader('content-type', 'text/html'); return res.end('<html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');}
  if (url.pathname.includes('/editor-document')) {
    if (req.method === 'GET') return json(res, documentView());
    const value = await body(req); if (value.revision !== revision) return json(res, {error: 'Fixture document conflict'}, 409);
    canvas = value.canvas; revision++; writes++; return json(res, documentView());
  }
  if (url.pathname.includes('/studio/generated-psd') || url.pathname.includes('/studio/decomposition/') || ['/studio/generation', '/studio/decomposition', '/studio/draft', '/workflow', '/workflow/assets'].includes(url.pathname)) {
    if (url.searchParams.get('projectId') !== fixture.projectId || url.searchParams.get('workspaceId') !== fixture.workspaceId || req.headers['x-novart-user'] !== fixture.userId) return json(res, {error: 'Fixture scope rejected'}, 403);
  }
  if (url.pathname === '/studio/draft') {
    if (req.method === 'GET') return json(res, draft);
    const value = contracts.WorkbenchDraftSaveInput.parse(await body(req)); if (value.revision !== draft.revision) return json(res, {error: 'Fixture draft conflict'}, 409);
    draft = contracts.WorkbenchDraftView.parse({...value, revision: draft.revision + 1, updatedAt: Date.now(), referenceIssues: []}); return json(res, draft);
  }
  if(url.pathname===`/api/workspaces/${fixture.workspaceId}/projects/${fixture.projectId}/studio-conversation`){
    if(req.headers['x-novart-user']!==fixture.userId)return json(res,{error:'Fixture conversation identity rejected'},403);
    if(req.method==='GET')return json(res,contracts.StudioConversationPage.parse({messages:[...messages].reverse(),nextCursor:null,draft:conversationDraft}));
    if(req.method==='PUT'){const value=contracts.StudioConversationDraftInput.parse(await body(req));if(value.revision!==(conversationDraft?.revision??0))return json(res,{error:'Fixture conversation draft conflict'},409);conversationDraft=contracts.StudioConversationDraft.parse({...value,revision:value.revision+1});return json(res,conversationDraft);}
    const input=contracts.StudioConversationInput.parse(await body(req));
    const generation=createGeneration({...input,prompt:input.text});
    const message=contracts.StudioConversationMessage.parse({messageId:'fixture-message-'+generationPosts,mutationId:input.mutationId,projectId:fixture.projectId,text:input.text,references:input.references,status:'SUCCEEDED',intent:null,generation,error:null,clarification:null,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+360000).toISOString()});
    messages.push(message);return json(res,message,202);
  }
  if (url.pathname === '/workflow/assets') return json(res, assets());
  if (url.pathname === '/workflow') {
    if (req.method === 'GET') return json(res, workflow);
    const value = contracts.StudioWorkflowSaveInput.parse(await body(req)); workflow = {...value, revision: workflow.revision + 1, updatedAt: Date.now(), issues: []}; return json(res, workflow);
  }
  if (url.pathname === '/studio/materials') return json(res, generations.length ? [material] : []);
  if (url.pathname === '/studio/material-upload') return json(res, {tasks: []});
  if (url.pathname === '/studio/generation') {
    if (req.method === 'POST') {
      throw new Error("The current UI must submit through conversation, not legacy generation");
    }
    const id = url.searchParams.get('requestId'); return id ? json(res, generations.find(value => value.requestId === id)) : json(res, {requests: generations});
  }
  if (url.pathname === '/studio/decomposition') {
    if (req.method === 'POST') {
      const input = contracts.StudioDecompositionInput.parse(await body(req));
      if (input.assetId !== layerResults[1].assetId) return json(res, {error: '这个合成预览只演示前景图层的一次细拆，没有调用真实模型；原图层仍保留。'}, 422);
      assert.equal(input.assetId, layerResults[1].assetId, 'Refinement uses the persisted selected layer');
      assert.equal(input.assetSha256, layerResults[1].assetSha256); assert.equal(input.documentRevision, revision);
      const source = shapes().find(value => value.id === input.sourceShapeId);
      assert.equal(source?.meta?.novartAssetId, input.assetId); assert.ok(!source.meta.novartOwned.hidden);
      decompositionPosts++; refinementInputs.push(input);
      const value = contracts.StudioDecompositionView.parse({...decompositions.get('fixture-generation-1').value,
        requestId: 'fixture-refinement-' + decompositionPosts, mutationId: input.mutationId, sourceShapeId: input.sourceShapeId,
        assetId: input.assetId, assetSha256: input.assetSha256, documentRevision: input.documentRevision,
        layerMode: input.layerMode, layerCount: 2, analysisStatus: 'PENDING', analysisSummary: null, status: 'PENDING', error: null, layers: []});
      refinementTasks.unshift({value, reads: 0}); return json(res, value, 202);
    }
    for (const entry of refinementTasks) {
      entry.reads++; entry.value = {...entry.value, status: entry.reads >= 2 ? 'SUCCEEDED' : 'RUNNING', analysisStatus: 'SUCCEEDED',
        analysisSummary: '合成细拆计划：把一个前景分成两部分（没有调用模型）', layers: entry.reads >= 2 ? refinedResults : []};
    }
    const requests = [...refinementTasks.map(entry => entry.value), ...[...decompositions.values()].map(entry => entry.value)];
    return json(res, url.searchParams.has('requestId') ? requests.find(value => value.requestId === url.searchParams.get('requestId')) : {requests});
  }
  if (url.pathname === `/api/workspaces/${fixture.workspaceId}/studio/generated-psd`) {
    const requestId = url.searchParams.get('requestId'), entry = decompositions.get(requestId); assert.ok(entry, 'Only explicitly requested PSD is read');
    entry.reads++;
    entry.value = {...entry.value, status: entry.fail ? 'FAILED' : entry.reads >= 3 ? 'SUCCEEDED' : entry.reads === 2 ? 'RUNNING' : 'PENDING', error: entry.fail ? '合成分层失败，仅验证错误隔离' : null, layers: !entry.fail && entry.reads >= 3 ? layerResults : [],
      ...(entry.value.layerMode === 'AUTO' ? {analysisStatus: entry.fail ? 'FAILED' : entry.reads >= 2 ? 'SUCCEEDED' : 'PENDING', analysisSummary: entry.reads >= 2 ? '合成分析计划：背景与前景（没有调用模型）' : null} : {})};
    const status = entry.value.status === 'SUCCEEDED' ? 'READY' : entry.value.status; psdReads.push({requestId, status});
    return json(res, contracts.StudioGeneratedPsdView.parse({projectId: fixture.projectId, requestId, requested: true, status, error: entry.value.error, decomposition: entry.value,
      downloadUrl: status === 'READY' ? `/api/workspaces/${fixture.workspaceId}/studio/decomposition/${entry.value.requestId}/export?projectId=${fixture.projectId}&format=psd` : null}));
  }
  if (url.pathname.match(/^\/api\/workspaces\/fixture-workspace\/studio\/decomposition\/fixture-decomposition-\d+\/export$/)) {
    exportReads++; if (denyExport) return json(res, {error: '合成导出拒绝，原图与图层保留'}, 403);
    res.writeHead(200, {'content-type': 'image/vnd.adobe.photoshop', 'content-length': psd.length, 'cache-control': 'no-store'}); return res.end(psd);
  }
  if (url.pathname === material.url) {res.setHeader('content-type', 'image/png'); return res.end(original.png);}
  const index = layerResults.findIndex(layer => layer.url === url.pathname); if (index >= 0) {res.setHeader('content-type', 'image/png'); return res.end(layers[index].png);}
  const refinedIndex = refinedResults.findIndex(layer => layer.url === url.pathname); if (refinedIndex >= 0) {res.setHeader('content-type', 'image/png'); return res.end(refinements[refinedIndex].png);}
  return json(res, {error: 'No fixture route'}, 404);
}
(async () => {
  const entry = path.join(directory, 'entry.tsx');
  fs.writeFileSync(entry, `import React from '${path.join(repo, 'apps/web/node_modules/react').replaceAll('\\', '/')}';\nimport {createRoot} from '${path.join(repo, 'apps/web/node_modules/react-dom/client').replaceAll('\\', '/')}';\nimport {OwnedEditorClient} from '${path.join(repo, 'apps/web/src/components/owned-canvas/OwnedEditorClient').replaceAll('\\', '/')}';\ncreateRoot(document.getElementById('root')!).render(<OwnedEditorClient {...${JSON.stringify(fixture)}} projectName="自动 PSD 交互样例 · 合成数据"/>);`);
  await esbuild.build({entryPoints: [entry], outfile: path.join(directory, 'app.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', tsconfig: path.join(repo, 'apps/web/tsconfig.json'), nodePaths: [path.join(repo, 'apps/web/node_modules')], define: {'process.env.NODE_ENV': '"development"'}, logLevel: 'silent'});
  const schemaEntry = path.join(directory, 'schema.ts'); fs.writeFileSync(schemaEntry, `export {WorkbenchDraftView,WorkbenchDraftSaveInput,StudioWorkflowSaveInput,StudioGenerationInput,StudioGenerationView,StudioDecompositionInput,StudioDecompositionView,StudioGeneratedPsdView,StudioConversationInput,StudioConversationMessage,StudioConversationDraftInput,StudioConversationDraft,StudioConversationPage} from '${path.join(repo, 'packages/contracts/src/index').replaceAll('\\', '/')}';export {workflowAssets} from '${path.join(repo, 'apps/web/src/lib/studio-workflow-codec').replaceAll('\\', '/')}';`);
  await esbuild.build({entryPoints: [schemaEntry], outfile: path.join(directory, 'schema.cjs'), bundle: true, platform: 'node', format: 'cjs', tsconfig: path.join(repo, 'apps/web/tsconfig.json'), nodePaths: [path.join(repo, 'apps/web/node_modules')], logLevel: 'silent'}); contracts = require(path.join(directory, 'schema.cjs'));
  const css = spawnSync(process.execPath, [path.join(repo, 'apps/web/node_modules/tailwindcss/lib/cli.js'), '-i', path.join(repo, 'packages/ui/src/styles.css'), '-o', path.join(directory, 'tokens.css'), '-c', path.join(repo, 'apps/web/tailwind.config.ts'), '--content', path.join(repo, 'apps/web/src/components/owned-canvas/*.{ts,tsx}')], {cwd: repo, encoding: 'utf8', env: {...process.env, TEMP: directory, TMP: directory}, timeout: 60000}); assert.equal(css.status, 0, 'Product styles compile');
  server = http.createServer((req, res) => handle(req, res).catch(error => {report.errors.push('fixture:' + error.name); json(res, {error: 'Fixture handler error'}, 500);}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true, ...(process.env.NOVART_CHROMIUM_EXECUTABLE ? {executablePath: process.env.NOVART_CHROMIUM_EXECUTABLE} : {}), args: ['--disable-background-networking']});
  const context = await browser.newContext({viewport: {width: 1440, height: 950}, acceptDownloads: true});
  await context.route('**/*', route => {const url = new URL(route.request().url()); if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) {report.externalRequests.push(url.hostname); return route.abort();} return route.continue();});
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.name)); let downloadEvents = 0; page.on('download', () => downloadEvents++);
  const button = name => page.getByRole('button', {name, exact: true});
  const closeTool=async()=>{const close=button('关闭工具窗口');if(await close.isVisible())await close.click();};
  const openPanel=async(label)=>{await closeTool();const settings=page.getByTestId('conversation-settings');if(await settings.isVisible()&&await settings.getAttribute('open')!==null)await settings.locator('summary').click();if(label==='分层'){const activity=page.getByRole('button',{name:/图片分层 ·/}).first();if(!await activity.isVisible())await page.getByRole('tab',{name:'对话改图',exact:true}).click();await activity.click();}else await page.getByRole('tab',{name:label,exact:true}).click();};
  const openAdvanced=async()=>{await closeTool();const details=page.getByTestId('conversation-settings');if(!await details.isVisible())await page.getByRole('tab',{name:'对话改图',exact:true}).click();if(await details.getAttribute('open')===null)await details.locator('summary').first().click();};
  const saved=()=>page.waitForFunction(()=>document.querySelector('[data-testid="conversation-draft-status"]')?.dataset.saved==='true');
  const ready=async()=>{await page.getByTestId('owned-canvas').waitFor();await openAdvanced();await saved();};
  const taskCard=id=>page.getByRole('region',{name:'项目任务记录',exact:true}).locator('[data-task-id="'+id+'"]');
  const submit=async()=>{await saved();const before=generationPosts;await button('发送').click();for(let i=0;i<150&&generationPosts===before;i++)await page.waitForTimeout(100);assert.equal(generationPosts,before+1);await saved();await page.waitForFunction(()=>document.querySelector('[data-testid="owned-editor"]')?.dataset.saveState==='saved');await openPanel('任务记录');};
  const expandPsd=async(card)=>{const details=card.getByTestId('owned-generated-psd');await details.waitFor();if(await details.getAttribute('open')===null)await details.locator('summary').click();};
  stage = 'default-off'; await page.goto(origin + '/'); await ready(); const checkbox = page.getByRole('checkbox', {name: '同时准备可编辑PSD', exact: true}); assert.equal(await checkbox.isChecked(), false); assert.equal(generationPosts, 0); assert.equal(decompositionPosts, 0); assert.equal(psdReads.length, 0); check('default-off-does-not-submit-or-read-any-extra-model-task');
  stage = 'automatic-choice'; await checkbox.check(); assert.equal(await page.getByRole('combobox', {name: 'PSD图层数量', exact: true}).count(), 0); assert.equal(await page.getByRole('combobox',{name:'PSD分层方式',exact:true}).inputValue(),'AUTO'); check('automatic-content-mode-hides-count-and-keeps-manual-advanced');
  if (process.env.NOVART_LAYER_AUTOMATIC_SCREENSHOT) await page.screenshot({path: process.env.NOVART_LAYER_AUTOMATIC_SCREENSHOT});
  await page.getByRole('textbox', {name: '对话设计需求', exact: true}).fill('合成图片自动 PSD 交互样例'); await submit();
  const card = taskCard('fixture-generation-1'); await card.waitFor(); await expandPsd(card); await card.locator('img').waitFor(); await card.getByTestId('owned-generated-psd').waitFor(); assert.equal(generationPosts, 1); assert.equal(generationInputs[0].psdLayerMode, 'AUTO'); assert.equal(Object.hasOwn(generationInputs[0], 'psdLayerCount'), false); assert.equal(decompositionPosts, 0); assert.equal(shapes().length, 1); check('automatic-intent-submitted-once-without-guessed-count-and-original-usable-before-PSD');
  stage = 'server-polling'; await card.locator('[data-testid="owned-generated-psd"][data-status="READY"]').waitFor({timeout: 20000}); assert.deepEqual(psdReads.slice(0,3).map(value => value.status), ['PENDING', 'RUNNING', 'READY']); assert(psdReads.length <= 5 && psdReads.slice(3).every(value=>value.status==='READY')); assert.equal(generationPosts, 1); assert.equal(decompositionPosts, 0); check('bounded-GET-polling-pending-running-ready-never-enqueues-from-browser');
  stage = 'failed-export'; await card.getByTestId('owned-generated-psd-download').click(); await page.locator('[data-testid="owned-notice"]:visible').filter({hasText: '合成导出拒绝'}).waitFor(); assert.equal(downloadEvents, 0); assert.equal(await card.locator('img').isVisible(), true); assert.equal(shapes().length, 1); check('403-JSON-is-not-downloaded-as-PSD-and-original-remains');
  stage = 'actual-download'; denyExport = false; const pendingDownload = page.waitForEvent('download'); await card.getByTestId('owned-generated-psd-download').click(); const download = await pendingDownload, downloaded = fs.readFileSync(await download.path()); assert.equal(downloaded.slice(0, 4).toString(), '8BPS'); const decoded = psdCodec.readPsd(downloaded, {skipLayerImageData: true, skipCompositeImageData: true}); assert.equal(decoded.width, 12); assert.equal(decoded.height, 8); assert.equal(decoded.children.length, 2); report.download = {fileName: download.suggestedFilename(), sizeBytes: downloaded.length, signature: '8BPS', width: decoded.width, height: decoded.height, layerCount: decoded.children.length, actualBrowserDownload: true, syntheticPixels: true}; check('browser-download-produces-readable-two-layer-PSD-with-source-dimensions');
  stage = 'automatic-layer-placement'; await card.getByRole('button', {name: '展开图片图层', exact: true}).click(); await page.waitForFunction(() => document.querySelector('[data-testid="owned-editor"]')?.dataset.saveState === 'saved' && document.querySelectorAll('[data-testid="owned-canvas-item"]').length === 3); assert.equal(shapes().length, 3); const originalRecord = shapes().find(value => value.meta?.novartAssetId === material.assetId); assert.ok(originalRecord && !originalRecord.meta?.novartOwned?.hidden); assert.equal(originalRecord.meta.novartAssetId, material.assetId); assert(shapes().filter(value=>layerResults.some(layer=>layer.assetId===value.meta?.novartAssetId)).every(value=>value.x>=originalRecord.x+originalRecord.props.w)); report.originalImagePreserved = true; check('automatic-source-stays-visible-and-layers-are-inserted-to-its-right');
  stage = 'repeat-placement'; const originalCanvas = canvas, originalWrites = writes, originalShapes = structuredClone(shapes()); await card.getByRole('button', {name: '展开图片图层', exact: true}).click(); await page.locator('[data-testid="owned-notice"]:visible').filter({hasText: '这一组图层已经在画布中'}).waitFor(); assert.equal(canvas, originalCanvas); assert.equal(writes, originalWrites); assert.equal(shapes().length, 3); check('repeated-expand-preserves-current-layer-edit-identities-without-extra-save');
  stage = 'refresh-recovery'; const baselinePosts = generationPosts; await page.reload(); await ready(); assert.equal(await checkbox.isChecked(), true); assert.equal(await page.getByRole('combobox', {name: 'PSD图层数量', exact: true}).count(), 0); assert.equal(canvas, originalCanvas); assert.equal(generationPosts, baselinePosts); assert.equal(decompositionPosts, 0); report.selectionRestored = true; check('refresh-restores-server-automatic-intent-and-layer-document-without-model-post');
  await openPanel('任务记录'); await expandPsd(card); await card.locator('[data-testid="owned-generated-psd"][data-status="READY"]').waitFor();
  if (process.env.NOVART_AUTO_PSD_SCREENSHOT) await page.screenshot({path: process.env.NOVART_AUTO_PSD_SCREENSHOT});
  stage = 'manual-layer-download'; await openPanel('分层'); const layerTask = page.getByTestId('owned-layer-task'); await layerTask.getByTestId('owned-layer-psd-download').waitFor(); const manualPending = page.waitForEvent('download'); await layerTask.getByTestId('owned-layer-psd-download').click(); const manual = await manualPending; assert.equal(fs.readFileSync(await manual.path()).slice(0, 4).toString(), '8BPS'); assert.equal(decompositionPosts, 0); check('existing-layer-panel-downloads-PSD-without-new-generation-or-decomposition');
  stage = 'unselected-generation'; await openAdvanced(); await checkbox.uncheck(); await page.getByRole('textbox', {name: '对话设计需求', exact: true}).fill('合成普通生图，无额外 PSD'); await submit(); await taskCard('fixture-generation-2').waitFor(); assert.equal(generationPosts, 2); assert.equal(Object.hasOwn(generationInputs[1], 'psdLayerCount'), false); assert.equal(Object.hasOwn(generationInputs[1], 'psdLayerMode'), false); assert.equal(decompositions.size, 1); assert.equal(decompositionPosts, 0); check('unselected-next-generation-omits-layer-count-mode-and-extra-task');
  stage = 'separate-layer-failure'; psdFailure = true; await openAdvanced(); await checkbox.check(); await page.getByRole('textbox', {name: '对话设计需求', exact: true}).fill('合成分层失败，原图保留'); await submit(); const failedCard = taskCard('fixture-generation-3'); await expandPsd(failedCard); await failedCard.locator('[data-testid="owned-generated-psd"][data-status="FAILED"]').waitFor(); assert.equal(await failedCard.locator('img').isVisible(), true); assert.equal(await failedCard.getByRole('button', {name: '恢复到画布', exact: true}).count(), 0); assert.equal(await failedCard.getByTestId('owned-generated-psd-download').count(), 0); assert.deepEqual(shapes(), originalShapes); assert.equal(decompositionPosts, 0); check('PSD-failure-preserves-generated-image-existing-canvas-and-original-generation');
  stage = 'refinement-target'; await openPanel('分层');
  const savedLayers = page.getByTestId('owned-layer-task').filter({has: page.getByTestId('owned-layer-compare-toggle')}).first();
  await savedLayers.getByTestId('owned-layer-compare-toggle').click();
  await savedLayers.getByRole('button', {name: '进一步分层：图层 2', exact: true}).click();
  const refinementPanel = page.getByTestId('owned-layer-panel');
  await refinementPanel.getByTestId('owned-layer-source').filter({hasText: '其余图层保留'}).waitFor();
  assert.equal(decompositionPosts, 0); assert.deepEqual(shapes(), originalShapes);
  assert.equal(await refinementPanel.getByRole('combobox', {name: '拆分层数', exact: true}).count(), 0);
  check('selecting-one-persisted-layer-for-refinement-does-not-pay-or-change-document');
  stage = 'refinement-submit'; await refinementPanel.getByTestId('owned-layer-submit').click();
  const refinedTask = page.getByTestId('owned-layer-task').filter({hasText: '合成细拆计划'});
  await refinedTask.locator('button').filter({hasText: '展开图片图层'}).waitFor({timeout: 20000});
  assert.equal(decompositionPosts, 1); assert.equal(refinementInputs[0].layerMode, 'AUTO');
  assert.equal(Object.hasOwn(refinementInputs[0], 'layerCount'), false);
  assert.equal(refinementInputs[0].assetId, layerResults[1].assetId);
  check('refinement-submits-one-auto-task-for-the-saved-layer-without-client-count');
  stage = 'refinement-placement'; await refinedTask.getByRole('button', {name: '展开图片图层', exact: true}).click();
  const settled = async count => page.waitForFunction(expected => document.querySelector('[data-testid="owned-editor"]')?.dataset.saveState === 'saved' && document.querySelectorAll('[data-testid="owned-canvas-item"]').length === expected, count);
  await settled(5); assert.equal(shapes().length, 5);
  const background = shapes().find(value => value.meta?.novartAssetId === layerResults[0].assetId);
  const oldForeground = shapes().find(value => value.meta?.novartAssetId === layerResults[1].assetId);
  assert.ok(background && !background.meta.novartOwned.hidden); assert.ok(!oldForeground.meta.novartOwned.hidden);
  assert.ok(!shapes().find(value => value.meta?.novartAssetId === material.assetId).meta.novartOwned.hidden);
  assert.equal(shapes().filter(value => refinedResults.some(layer => layer.assetId === value.meta?.novartAssetId)).length, 2);
  check('refinement-keeps-original-ancestor-and-other-layer-and-inserts-only-selected-layer-children');
  stage = 'refinement-history'; await closeTool(); await button('撤销').click(); await settled(3); assert.equal(shapes().length, 3);
  assert.ok(!shapes().find(value => value.meta?.novartAssetId === layerResults[1].assetId).meta.novartOwned.hidden);
  await button('重做').click(); await settled(5); assert.equal(shapes().length, 5);
  check('one-undo-restores-selected-source-and-redo-restores-refinement-without-new-task');
  stage = 'refinement-refresh'; await page.reload(); await ready(); await settled(5);
  assert.equal(shapes().length, 5); assert.equal(decompositionPosts, 1); assert.equal(generationPosts, 3);
  await openPanel('分层'); await page.getByTestId('owned-layer-task').filter({hasText: '合成细拆计划'}).waitFor();
  check('recursive-layers-and-server-task-reopen-without-model-resubmission');
  stage = 'phone-refinement-layout'; await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  if (process.env.NOVART_LAYER_SCREENSHOT) await page.screenshot({path: process.env.NOVART_LAYER_SCREENSHOT});
  await page.setViewportSize({width: 1440, height: 950}); check('phone-refinement-panel-has-no-document-horizontal-overflow');
  stage = 'advanced-manual-choice'; psdFailure = false; await openAdvanced(); await checkbox.check();
  await page.getByRole('combobox',{name:'PSD分层方式',exact:true}).selectOption('MANUAL'); await page.getByRole('spinbutton',{name:'PSD图层数量',exact:true}).fill('2');
  await page.getByRole('textbox', {name: '对话设计需求', exact: true}).fill('合成手动两层，兼容旧任务'); await submit();
  await taskCard('fixture-generation-4').locator('[data-testid="owned-generated-psd"][data-status="READY"]').waitFor();
  assert.equal(generationInputs[3].psdLayerMode, 'MANUAL'); assert.equal(generationInputs[3].psdLayerCount, 2);
  await page.reload(); await ready(); assert.equal(await checkbox.isChecked(), true);
  assert.equal(await page.getByRole('spinbutton', {name: 'PSD图层数量', exact: true}).inputValue(), '2');
  assert.equal(decompositionPosts, 1); assert.equal(generationPosts, 4); await settled(5);
  check('advanced-manual-count-remains-explicit-and-restores-without-model-post');
  assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.errors, []); report.generationPosts = generationPosts; report.browserDecompositionPosts = decompositionPosts; report.exportReads = exportReads; report.passed = true;
})().catch(error => {report.passed = false; report.fatal = {stage, name: error.name, message: String(error.message).slice(0, 500), stack: String(error.stack).slice(0, 1200)}; process.exitCode = 1;}).finally(async () => {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
  if (process.env.NOVART_AUTO_PSD_REPORT) fs.writeFileSync(process.env.NOVART_AUTO_PSD_REPORT, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  assert.equal(path.dirname(directory), temporaryRoot); fs.rmSync(directory, {recursive: true, force: true});
});

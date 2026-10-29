/* Production React panel + authenticated-shape loopback PNG fixtures, real Chrome.
 * Tests interaction and pixels only, never provider quality or backend auth. */
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
const output = path.join(repo, '.novart-build', 'layer-quality-interactions');
fs.mkdirSync(output, {recursive: true});
const buildPackage = fs.readdirSync(path.join(repo, 'node_modules/.pnpm')).find(name => name.startsWith('esbuild@0.28.'));
assert.ok(buildPackage, 'Installed esbuild is required');
const esbuild = require(path.join(repo, 'node_modules/.pnpm', buildPackage, 'node_modules/esbuild'));
const report = {fixtureOnly: true, realProvider: false, realBackend: false, realAuthorization: false, providerCalls: 0, checks: [], externalRequests: [], errors: []};
let browser, server, stage = 'build', mode = '', rawReads = [], posts = 0, closedRequests = 0;
const check = name => { report.checks.push(name); console.log('PASS ' + name); };
function chunk(type, bytes) {
  const payload = Buffer.concat([Buffer.from(type), bytes]), out = Buffer.alloc(bytes.length + 12); let crc = 0xffffffff;
  for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  out.writeUInt32BE(bytes.length); payload.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
}
function png(pixel) {
  const width = 12, height = 8, header = Buffer.alloc(13), rgba = Buffer.alloc(height * (width * 4 + 1));
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) Buffer.from(pixel(x, y)).copy(rgba, y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rgba)), chunk('IEND', Buffer.alloc(0))]);
}
const foreground = (x,y) => x >= 3 && x < 7 && y >= 2 && y < 5 ? [220,70,90,255] : [0,0,0,0];
const background = () => [124,92,255,255];
const bytes = [png((x,y) => foreground(x,y)[3] ? foreground(x,y) : background()), png(background), png(foreground)];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const assets = new Map();
function task(id, qualityStatus, projectId = 'p') {
  const assetId = id + '-source', layerIds = [id + '-back', id + '-front'];
  [assetId, ...layerIds].forEach((asset, index) => assets.set(asset, bytes[index]));
  const quality = qualityStatus ? {revision:'layer-quality-r1',status:qualityStatus,sourceSha256:hash(bytes[0]),sourceWidth:12,sourceHeight:8,sampleWidth:12,sampleHeight:8,
    metrics:{meanAbsoluteError:qualityStatus==='REVIEW_REQUIRED'?20:0,changedPixelRatio:qualityStatus==='REVIEW_REQUIRED'?0.2:0,alphaMeanAbsoluteError:0},
    regions:qualityStatus==='REVIEW_REQUIRED'?[{left:3,top:2,width:4,height:3,changedPixelRatio:0.3}]:[],
    thresholds:{changedChannelDelta:24,meanAbsoluteError:8,changedPixelRatio:0.05,alphaMeanAbsoluteError:8,regionChangedPixelRatio:0.1},
    warnings:qualityStatus==='REVIEW_REQUIRED'?['COMPOSITE_DIFFERENCE','LOCAL_DIFFERENCE']:[],unavailableReason:null,semanticsChecked:false,textChecked:false,humanReviewRequired:true,checkedAt:'2026-10-29T00:00:00.000Z'} : null;
  if (qualityStatus === 'UNAVAILABLE') Object.assign(quality,{sampleWidth:null,sampleHeight:null,metrics:null,regions:[],warnings:['QUALITY_CHECK_UNAVAILABLE'],unavailableReason:'SOURCE_UNAVAILABLE'});
  return {requestId:id,mutationId:crypto.randomUUID(),projectId,sourceShapeId:'shape:'+assetId,assetId,assetSha256:hash(bytes[0]),documentRevision:0,layerCount:2,layerMode:'MANUAL',sourceWidth:12,sourceHeight:8,
    status:'SUCCEEDED',error:null,createdAt:'2026-10-29T00:00:00.000Z',expiresAt:'2026-10-29T00:06:00.000Z',archiveExpiresAt:null,canRetryArchive:false,...(quality ? {quality}:{}),
    layers:layerIds.map((assetId,order)=>({assetId,order,assetSha256:hash(bytes[order+1]),mimeType:'image/png',width:12,height:8,sizeBytes:bytes[order+1].length,url:`/api/workspaces/w/assets/${assetId}/raw`,alphaBounds:{left:0,top:0,width:12,height:8},inkCoverage:0.5}))};
}
const tasks = [task('legacy', null), task('match', 'COMPOSITE_MATCH'), task('review', 'REVIEW_REQUIRED'), task('unavailable', 'UNAVAILABLE')];
const other = task('other', null, 'other-project');
const oversized = task('oversized', null, 'large-project');
oversized.sourceWidth = 12000; oversized.sourceHeight = 12000; oversized.layers.forEach(layer=>{layer.width=12000;layer.height=12000;});
function json(res,value,status=200) {res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function handle(req,res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (!['GET','HEAD'].includes(req.method)) {posts++;return json(res,{error:'No writes allowed'},405);}
  if (url.pathname === '/app.js' || url.pathname === '/app.css') {res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':'text/css');return res.end(fs.readFileSync(path.join(output,path.basename(url.pathname))));}
  if (url.pathname.startsWith('/fonts/')) {res.writeHead(404);return res.end();}
  if (url.pathname === '/api/novart/studio/decomposition' || url.pathname === '/studio/decomposition') {
    const project = url.searchParams.get('projectId');
    return json(res,{requests:project==='p'?tasks:project==='large-project'?[oversized]:[other]});
  }
  if (url.pathname.startsWith('/api/workspaces/w/assets/') && url.pathname.endsWith('/raw')) {
    const id = url.pathname.split('/')[5]; rawReads.push({id,user:req.headers['x-novart-user'],cookie:!!req.headers.cookie});
    if(req.headers['x-novart-user']!=='u'||!req.headers.cookie)return json(res,{error:'Fixture requires same-origin identity'},403);
    if(mode==='fail') {mode='';return json(res,{error:'Fixture read failure'},503);}
    if(mode==='hang') {res.on('close',()=>{closedRequests++;});return;}
    res.writeHead(200, {'Content-Type':'image/png','Cache-Control':'no-store'});return res.end(mode==='changed'?bytes[2]:assets.get(id));
  }
  if(url.pathname !== '/') return json(res,{error:'Unexpected fixture path '+url.pathname},404);
  res.setHeader('Content-Type','text/html'); res.setHeader('Set-Cookie','fixture-scope=w; HttpOnly; SameSite=Lax; Path=/');
  res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
}
(async()=>{
  const source = name => path.join(repo,name).replaceAll('\\','/');
  const entry = path.join(output,'entry.tsx');
  fs.writeFileSync(entry,`import React,{useMemo,useState} from '${source('apps/web/node_modules/react')}';
import {createRoot} from '${source('apps/web/node_modules/react-dom/client')}';
import {OwnedLayerPanel} from '${source('apps/web/src/components/owned-canvas/OwnedLayerPanel')}';
import {createOwnedEditorApi} from '${source('apps/web/src/components/owned-canvas/owned-editor-api')}';
import {emptyOwnedDocument} from '${source('apps/web/src/lib/owned-canvas-model')}';
const doc=emptyOwnedDocument(); function Harness(){const [project,setProject]=useState('p'),[readOnly,setReadOnly]=useState(false);const api=useMemo(()=>createOwnedEditorApi('w',project,'u'),[project]);
return <main className="mx-auto w-full max-w-2xl space-y-4 p-4"><p>交互测试夹具，不代表模型质量</p><nav className="flex flex-wrap gap-3"><button onClick={()=>setProject('p')}>项目一</button><button onClick={()=>setProject('other-project')}>项目二</button><button onClick={()=>setProject('large-project')}>大尺寸项目</button><button onClick={()=>setReadOnly(v=>!v)}>切换只读</button></nav><OwnedLayerPanel api={api} workspaceId="w" projectId={project} userId="u" document={doc} selectedIds={[]} readOnly={readOnly} onPrepare={async()=>{throw Error('Unexpected preparation')}} onPlace={async()=>{window.fixturePlacements=(window.fixturePlacements||0)+1;}} /></main>};createRoot(document.getElementById('root')!).render(<Harness/>);`);
  await esbuild.build({entryPoints:[entry],outfile:path.join(output,'app.js'),bundle:true,platform:'browser',format:'iife',jsx:'automatic',tsconfig:path.join(repo,'apps/web/tsconfig.json'),nodePaths:[path.join(repo,'apps/web/node_modules')],define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
  const css=spawnSync(process.execPath,[path.join(repo,'apps/web/node_modules/tailwindcss/lib/cli.js'),'-i',path.join(repo,'packages/ui/src/styles.css'),'-o',path.join(output,'app.css'),'-c',path.join(repo,'apps/web/tailwind.config.ts'),'--content',[entry,path.join(repo,'apps/web/src/components/owned-canvas/*.{ts,tsx}')].join(',')],{cwd:repo,encoding:'utf8',timeout:60000});assert.equal(css.status,0,css.stderr);
  server=http.createServer((req,res)=>void handle(req,res).catch(error=>json(res,{error:error.message},500)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const installedChrome='C:/Program Files/Google/Chrome/Application/chrome.exe';
  const executablePath=process.env.NOVART_CHROMIUM_EXECUTABLE||(fs.existsSync(installedChrome)?installedChrome:undefined);
  browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--disable-background-networking']});
  const context=await browser.newContext({viewport:{width:1100,height:950}});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==origin){report.externalRequests.push(url.hostname);return route.abort();}return route.continue();});
  await context.addInitScript(()=>{window.liveFixtureBitmaps=new Set();const make=window.createImageBitmap;window.createImageBitmap=async(...args)=>{const image=await make(...args);window.liveFixtureBitmaps.add(image);return image;};const close=ImageBitmap.prototype.close;ImageBitmap.prototype.close=function(){window.liveFixtureBitmaps.delete(this);return close.call(this);};});
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
  const card=id=>page.locator(`[data-testid="owned-layer-task"][data-request-id="${id}"]`);
  const toggle=id=>card(id).getByTestId('owned-layer-compare-toggle');
  const ready=id=>card(id).locator('[data-testid="owned-layer-comparison"][data-state="ready"]').waitFor();
  const pixel=async(x,y)=>page.getByRole('img',{name:'图片图层对照',exact:true}).evaluate((canvas,[x,y])=>Array.from(canvas.getContext('2d').getImageData(x,y,1,1).data),[x,y]);
  const zeroBitmaps=async()=>page.waitForFunction(()=>window.liveFixtureBitmaps.size===0);
  stage='initial-unchecked';await page.goto(origin);await card('legacy').waitFor();
  assert.equal(rawReads.length,0);assert.equal(await page.getByTestId('owned-layer-comparison').count(),0);
  assert.match(await card('legacy').getByTestId('owned-layer-quality').innerText(),/尚未做质量初检/);
  assert.match(await card('match').getByTestId('owned-layer-quality').innerText(),/未见明显重合成差异/);
  assert.match(await card('review').getByTestId('owned-layer-quality').innerText(),/需复核/);
  assert.match(await card('unavailable').getByTestId('owned-layer-quality').innerText(),/暂不可用/);
  assert.doesNotMatch(await page.getByTestId('owned-layer-panel').innerText(),/质量通过|原生文字层已/);check('stored-pngs-and-four-quality-states-have-no-false-pass-or-eager-image-reads');
  stage='ordered-composite';await toggle('legacy').click();await ready('legacy');
  assert.deepEqual(rawReads.map(value=>value.id),['legacy-source','legacy-back','legacy-front']);assert(rawReads.every(value=>value.user==='u'&&value.cookie));
  assert.deepEqual(await pixel(4,3),[220,70,90,255]);assert.deepEqual(await pixel(0,0),[124,92,255,255]);
  await page.getByRole('combobox',{name:'对照查看范围'}).selectOption('legacy-front');assert.deepEqual(await pixel(0,0),[0,0,0,0]);
  await page.getByRole('button',{name:'恢复全部图层'}).click();await page.getByRole('checkbox',{name:'图层 1',exact:true}).uncheck();await page.getByRole('checkbox',{name:'图层 2',exact:true}).uncheck();assert.deepEqual(await pixel(4,3),[0,0,0,0]);
  check('ordered-alpha-composite-and-layer-inspection-never-use-original-as-bottom-layer');
  await page.evaluate(()=>{window.retiredFixtureCanvases=[...document.querySelectorAll('[data-testid="owned-layer-comparison"] canvas')];});
  await toggle('legacy').click();await zeroBitmaps();assert.equal(await page.evaluate(()=>window.retiredFixtureCanvases.every(canvas=>canvas.width===0&&canvas.height===0)),true);check('closing-preview-disposes-bitmaps-and-canvas-backing-stores');
  stage='read-error-retry';mode='fail';await toggle('match').click();await card('match').getByRole('alert').waitFor();assert.match(await card('match').getByRole('alert').innerText(),/暂时无法读取/);await page.getByRole('button',{name:'重新加载对照'}).click();await ready('match');check('failed-asset-read-has-retry-and-successful-recovery');
  stage='task-switch';await toggle('review').click();await ready('review');assert.equal(await page.getByTestId('owned-layer-comparison').count(),1);assert.equal(await toggle('match').getAttribute('aria-expanded'),'false');await page.getByRole('checkbox',{name:'标出初检差异区域（全图层结果）'}).check();assert.equal(await page.locator('svg[aria-label="初检差异区域"] rect').count(),1);check('switching-tasks-disposes-old-preview-and-shows-local-difference-region');
  stage='read-only-mobile';await page.getByRole('button',{name:'切换只读',exact:true}).click();assert.equal(await card('review').getByRole('button',{name:'展开图片图层',exact:true}).isDisabled(),true);assert.equal(await toggle('review').isEnabled(),true);
  await page.setViewportSize({width:375,height:812});await page.getByRole('combobox',{name:'对照查看范围'}).selectOption('review-front');assert.deepEqual(await pixel(0,0),[0,0,0,0]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.screenshot({path:path.join(output,'mobile-fixture.png'),fullPage:true});check('read-only-still-allows-inspection-and-mobile-layout-fits-375px');
  stage='project-switch-during-read';await toggle('review').click();mode='hang';const readsBefore=rawReads.length;await toggle('match').click();await page.waitForFunction(()=>document.querySelector('[data-testid="owned-layer-comparison"]')?.dataset.state==='loading');await page.waitForTimeout(100);assert(rawReads.length>readsBefore);
  await page.getByRole('button',{name:'项目二',exact:true}).click();await card('other').waitFor();await zeroBitmaps();assert.equal(await page.getByTestId('owned-layer-comparison').count(),0);mode='';await toggle('other').click();await ready('other');assert.equal(await page.getByTestId('owned-layer-comparison').getAttribute('data-request-id'),'other');assert.equal(closedRequests>0,true);check('project-switch-aborts-asset-read-and-never-revives-old-task');
  stage='changed-bytes';await toggle('other').click();mode='changed';await toggle('other').click();await card('other').getByRole('alert').waitFor();assert.match(await card('other').getByRole('alert').innerText(),/保存版本不一致/);await zeroBitmaps();mode='';check('source-hash-mismatch-fails-closed-before-image-decoding');
  stage='memory-budget';await page.getByRole('button',{name:'大尺寸项目',exact:true}).click();await card('oversized').waitFor();const budgetReads=rawReads.length;await toggle('oversized').click();await card('oversized').getByRole('alert').waitFor();assert.match(await card('oversized').getByRole('alert').innerText(),/内存预算/);assert.equal(rawReads.length,budgetReads);check('oversized-dimensions-stop-before-any-image-fetch');
  stage='timeout';await page.getByRole('button',{name:'项目一',exact:true}).click();await card('match').waitFor();mode='hang';await toggle('match').click();await card('match').getByRole('alert').waitFor({timeout:30000});assert.match(await card('match').getByRole('alert').innerText(),/加载超时/);mode='';await page.getByRole('button',{name:'重新加载对照'}).click();await ready('match');check('25-second-timeout-aborts-read-and-offers-working-retry');
  await toggle('match').click();await zeroBitmaps();assert.equal(posts,0);assert.equal(await page.evaluate(()=>window.fixturePlacements||0),0);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);check('all-inspection-actions-issue-zero-writes-placement-or-provider-calls');
  report.passed=true;report.rawReads=rawReads.length;report.closedRequests=closedRequests;report.browser=await browser.version();
})().catch(error=>{report.passed=false;report.stage=stage;report.failure=error.stack;console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log('Report: '+path.join(output,'report.json'));});

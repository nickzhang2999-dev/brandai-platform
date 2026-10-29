/* Production OwnedCanvas engine interactions on an isolated loopback fixture.
 * Synthetic images exercise DOM lifetime, camera hit testing and document codecs.
 * No authentication, database, provider, CDS or existing browser is accessed. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright-core');
const repo = path.resolve(__dirname, '..');
const temporaryRoot = path.join(repo, '.novart-build', 'temporary');
fs.mkdirSync(temporaryRoot, {recursive: true});
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'engine-browser-'));
const installed = fs.readdirSync(path.join(repo, 'node_modules/.pnpm')).find(name => name.startsWith('esbuild@0.28.'));
assert.ok(installed, 'Use the already installed build dependency');
const esbuild = require(path.join(repo, 'node_modules/.pnpm', installed, 'node_modules/esbuild'));
const sharp = require(path.join(repo, 'apps/web/node_modules/sharp'));
const report = {isolated: true, realBackend: false, realProvider: false, providerCalls: 0,
  fixtureScope: 'Production React canvas; synthetic 224-object scene; actual gzip codec; loopback HTTP only',
  checks: [], errors: [], externalRequests: []};
let server, browser, stage = 'prepare';
const check = name => report.checks.push(name);

(async () => {
  const png = await sharp({create: {width: 96, height: 64, channels: 4, background: {r: 28, g: 130, b: 215, alpha: 1}}}).png().toBuffer();
  const entry = path.join(directory, 'entry.tsx');
  fs.writeFileSync(entry, `import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{OwnedCanvas}from ${JSON.stringify(path.join(repo, 'apps/web/src/components/owned-canvas/OwnedCanvas.tsx'))};
import{assignOwnedImageNames,emptyOwnedDocument,serializeOwnedDocument}from ${JSON.stringify(path.join(repo, 'apps/web/src/lib/owned-canvas-model.ts'))};
import{ownedCanvasEngine}from ${JSON.stringify(path.join(repo, 'apps/web/src/lib/owned-canvas-engine/index.ts'))};
const shape=(id,x,y,w=40,h=40)=>({id:'shape:'+id,kind:'shape',shape:'rect',x,y,w,h,rotation:0,opacity:1,fill:'#ede9fe',stroke:'#7c5cff',strokeWidth:2});
const image=(id,x)=>({id:'shape:'+id,kind:'image',x,y:130,w:192,h:128,rotation:0,opacity:1,url:'/image.png',assetId:id,assetSha256:'a'.repeat(64)});
function App(){const[epoch,setEpoch]=useState(0);const[doc,setDoc]=useState(()=>assignOwnedImageNames({...emptyOwnedDocument(),camera:{x:0,y:0,zoom:1},items:[
...Array.from({length:220},(_,index)=>shape('far-'+index,4000+index*80,120+(index%6)*90)),
image('near-image',140),image('far-image',2400),shape('a-back',500,240,160,120),shape('z-front',540,280,160,120)]}));
window.fixtureSnapshot=()=>serializeOwnedDocument(doc);window.fixtureDocument=()=>doc;
window.fixtureReopen=async()=>{const encoded=await ownedCanvasEngine.encodeDocument(doc);const restored=await ownedCanvasEngine.decodeDocument(encoded);setDoc(restored);setEpoch(value=>value+1);return{encoded,source:ownedCanvasEngine.serializeDocument(restored)};};
window.fixtureExportImages=()=>ownedCanvasEngine.exportSvg(doc,{itemIds:['shape:near-image','shape:far-image']});
return <div style={{position:'relative',width:'100vw',height:'100vh'}}><OwnedCanvas key={epoch} document={doc} clipboardScope="engine-fixture" onChange={setDoc}/></div>;
}createRoot(document.getElementById('root')).render(<App/>);`);
  await esbuild.build({entryPoints: [entry], bundle: true, outfile: path.join(directory, 'app.js'), jsx: 'automatic', platform: 'browser', loader: {'.css': 'css'},
    alias: {'@': path.join(repo, 'apps/web/src')}, nodePaths: [path.join(repo, 'apps/web/node_modules')], logLevel: 'silent'});
  const css = spawnSync(process.execPath, [path.join(repo, 'apps/web/node_modules/tailwindcss/lib/cli.js'), '-i', path.join(repo, 'packages/ui/src/styles.css'),
    '-o', path.join(directory, 'tokens.css'), '-c', path.join(repo, 'apps/web/tailwind.config.ts'), '--content', path.join(repo, 'apps/web/src/components/owned-canvas/*.{ts,tsx}')],
  {cwd: repo, encoding: 'utf8', timeout: 60000});
  assert.equal(css.status, 0, 'Product CSS must compile: ' + css.stderr);
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/image.png') {res.setHeader('Content-Type', 'image/png'); return res.end(png);}
    if (['/app.js', '/app.css', '/tokens.css'].includes(url.pathname)) {
      res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript');
      return res.end(fs.readFileSync(path.join(directory, url.pathname.slice(1))));
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><head><meta charset="utf-8"><style>body{margin:0}button,input,textarea{font:inherit}</style><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless: true, executablePath: process.env.NOVART_CHROMIUM_EXECUTABLE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args: ['--no-proxy-server', '--disable-dev-shm-usage']});
  const context = await browser.newContext({viewport: {width: 1280, height: 820}});
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) {report.externalRequests.push(url.hostname); return route.abort();}
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(String(error.message)));
  await page.goto(origin);
  const surface = page.getByTestId('owned-canvas');
  const object = id => page.locator(`[data-owned-id="shape:${id}"]`);
  const documentItem = id => page.evaluate(value => fixtureDocument().items.find(item => item.id === 'shape:' + value), id);
  const selected = id => object(id).getAttribute('data-selected');
  await surface.waitFor();

  stage = 'initial-large-scene-culling';
  await page.waitForFunction(() => document.querySelectorAll('[data-owned-culled="true"]').length >= 220);
  assert.equal(await page.getByTestId('owned-canvas-item').count(), 224, 'Culling retains records and DOM containers');
  assert.equal(await object('near-image').isVisible(), true);
  assert.equal(await object('far-image').getAttribute('data-owned-culled'), 'true');
  await page.evaluate(() => {
    window.retainedImageNode = document.querySelector('[data-owned-id="shape:near-image"]');
    window.retainedImageContent = retainedImageNode.querySelector('image');
    window.initialDomOrder = [...document.querySelector('.oc-world').children].map(node => node.dataset.ownedId);
  });
  check('224-record-scene-culls-offscreen-content-without-unmounting');

  stage = 'camera-cull-and-return';
  await page.mouse.move(1100, 500); await page.mouse.wheel(2200, 0);
  await page.waitForFunction(() => document.querySelector('[data-owned-id="shape:near-image"]')?.dataset.ownedCulled === 'true'
    && !document.querySelector('[data-owned-id="shape:far-image"]')?.dataset.ownedCulled);
  await object('far-image').click();
  assert.equal(await selected('far-image'), 'true', 'The latest camera must also drive pointer hit testing');
  await page.keyboard.press('Escape'); await page.mouse.move(1100, 500); await page.mouse.wheel(-2200, 0);
  await object('near-image').waitFor({state: 'visible'});
  assert.deepEqual(await page.evaluate(() => ({container: retainedImageNode === document.querySelector('[data-owned-id="shape:near-image"]'),
    image: retainedImageContent === document.querySelector('[data-owned-id="shape:near-image"] image'), href: retainedImageContent.getAttribute('href')})),
  {container: true, image: true, href: '/image.png'});
  check('pan-out-and-back-keeps-the-same-image-and-container-nodes');

  stage = 'selected-culling-protection';
  await object('near-image').click(); await page.mouse.move(1100, 500); await page.mouse.wheel(2200, 0);
  await page.waitForFunction(() => Math.abs(fixtureDocument().camera.x + 2200) < .01);
  assert.notEqual(await object('near-image').getAttribute('data-owned-culled'), 'true', 'Selected offscreen objects remain mounted and protected');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[data-owned-id="shape:near-image"]')?.dataset.ownedCulled === 'true');
  await page.mouse.wheel(-2200, 0); await object('near-image').waitFor({state: 'visible'});
  check('selection-protection-ends-when-selection-is-cleared');

  stage = 'multi-event-pan';
  await page.getByRole('button', {name: '移动画布', exact: true}).click();
  const beforePan = await object('near-image').boundingBox(); assert.ok(beforePan);
  await page.evaluate(() => {
    window.cameraWrites = 0;
    window.cameraObserver = new MutationObserver(records => {cameraWrites += records.length;});
    cameraObserver.observe(document.querySelector('.oc-world'), {attributes: true, attributeFilter: ['style']});
  });
  await page.mouse.move(1000, 500); await page.mouse.down(); await page.mouse.move(1060, 550, {steps: 12});
  const duringPan = await object('near-image').boundingBox(); assert.ok(duringPan);
  assert.ok(Math.abs(duringPan.x - beforePan.x - 60) < .1 && Math.abs(duringPan.y - beforePan.y - 50) < .1, 'World DOM tracks an in-flight multi-event pan');
  assert.ok(await page.evaluate(() => cameraWrites) >= 2, 'Several pointer events update the camera DOM before the gesture ends');
  await page.mouse.up();
  await page.mouse.down(); await page.mouse.move(1000, 500, {steps: 12}); await page.mouse.up();
  await page.evaluate(() => cameraObserver.disconnect());
  await page.getByRole('button', {name: '选择', exact: true}).click();
  check('multi-event-pan-updates-world-dom-before-pointer-release');

  stage = 'zoom-and-pointer-coordinate-consistency';
  await page.mouse.move(240, 200); await page.keyboard.down('Control'); await page.mouse.wheel(0, -180); await page.keyboard.up('Control');
  await page.waitForFunction(() => fixtureDocument().camera.zoom > 1.2);
  const beforeDrag = await documentItem('near-image');
  const zoom = await page.evaluate(() => fixtureDocument().camera.zoom);
  const rect = await object('near-image').boundingBox(); assert.ok(rect);
  await page.keyboard.down('Alt'); await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down(); await page.mouse.move(rect.x + rect.width / 2 + 44, rect.y + rect.height / 2 + 32, {steps: 6}); await page.mouse.up(); await page.keyboard.up('Alt');
  const moved = await documentItem('near-image');
  assert.ok(Math.abs(moved.x - beforeDrag.x - 44 / zoom) < 1, 'Drag x uses the new camera zoom');
  assert.ok(Math.abs(moved.y - beforeDrag.y - 32 / zoom) < 1, 'Drag y uses the new camera zoom');
  await page.keyboard.press('Control+z'); assert.equal((await documentItem('near-image')).x, beforeDrag.x);
  await page.keyboard.press('Control+Shift+z'); assert.equal((await documentItem('near-image')).x, moved.x);
  await page.keyboard.press('Control+z'); await page.keyboard.press('Escape');
  await page.mouse.move(240, 200); await page.keyboard.down('Control'); await page.mouse.wheel(0, 180); await page.keyboard.up('Control');
  await page.waitForFunction(() => Math.abs(fixtureDocument().camera.zoom - 1) < .001);
  check('zoomed-hit-testing-drag-and-history-share-the-current-camera');

  stage = 'reorder-without-dom-moves';
  await page.evaluate(() => {
    window.domMoves = 0;
    window.orderObserver = new MutationObserver(records => {domMoves += records.filter(record => record.type === 'childList').length;});
    orderObserver.observe(document.querySelector('.oc-world'), {childList: true});
  });
  await page.mouse.click(520, 260, {button: 'right'});
  await page.getByRole('menuitem', {name: '置于顶层', exact: true}).click();
  await page.waitForFunction(() => fixtureDocument().items.at(-1)?.id === 'shape:a-back');
  await page.mouse.click(580, 320); assert.equal(await selected('a-back'), 'true', 'The new topmost shape wins overlap hit testing');
  const order = await page.evaluate(() => ({changes: domMoves, current: [...document.querySelector('.oc-world').children].map(node => node.dataset.ownedId), initial: initialDomOrder,
    back: Number(document.querySelector('[data-owned-id="shape:a-back"]').style.zIndex), front: Number(document.querySelector('[data-owned-id="shape:z-front"]').style.zIndex)}));
  assert.equal(order.changes, 0, 'Changing z-order must not reinsert image DOM containers');
  assert.deepEqual(order.current, order.initial); assert.ok(order.back > order.front);
  await page.evaluate(() => orderObserver.disconnect());
  check('z-order-changes-paint-and-hit-order-without-reordering-dom-nodes');

  stage = 'text-and-brush';
  await page.keyboard.press('Escape'); await page.getByRole('button', {name: '文字', exact: true}).click(); await page.mouse.click(520, 490);
  const text = page.getByRole('textbox', {name: '编辑画布文字', exact: true}); await text.fill('引擎适配\n中文文字'); await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => fixtureDocument().items.some(item => item.kind === 'text' && item.text === '引擎适配\n中文文字'));
  await page.getByRole('button', {name: '更多画布工具', exact: true}).click();
  await page.getByRole('button', {name: '画笔', exact: true}).click();
  await page.mouse.move(170, 520); await page.mouse.down(); await page.mouse.move(210, 540, {steps: 5}); await page.mouse.move(250, 510, {steps: 5}); await page.mouse.up();
  assert.equal(await page.evaluate(() => fixtureDocument().items.filter(item => item.kind === 'stroke' && item.points.length > 5).length), 1);
  await surface.focus(); await page.keyboard.press('Control+z'); assert.equal(await page.evaluate(() => fixtureDocument().items.filter(item => item.kind === 'stroke').length), 0);
  await page.keyboard.press('Control+Shift+z'); assert.equal(await page.evaluate(() => fixtureDocument().items.filter(item => item.kind === 'stroke').length), 1);
  check('large-scene-text-editing-and-brush-undo-redo-remain-interactive');

  stage = 'save-codec-and-reopen';
  const imageSvg = await page.evaluate(() => fixtureExportImages());
  assert.equal((imageSvg.match(/<image\s/g) || []).length, 2, 'Export adapter includes the offscreen image together with the visible image');
  assert.equal((imageSvg.match(/data:image\/png;base64,/g) || []).length, 2);
  check('engine-export-includes-offscreen-images-from-the-full-document');
  const before = await page.evaluate(() => fixtureSnapshot());
  await page.evaluate(() => {window.previousCanvasRoot = document.querySelector('[data-testid="owned-canvas"]');});
  const reopened = await page.evaluate(() => fixtureReopen());
  assert.ok(reopened.encoded.startsWith('SHAKKERDATA://')); assert.deepEqual(reopened.source, before);
  await page.waitForFunction(() => fixtureDocument().items.length === 226 && !previousCanvasRoot.isConnected
    && document.querySelector('[data-testid="owned-canvas"]') !== previousCanvasRoot);
  assert.equal(await page.getByTestId('owned-canvas-item').count(), 226);
  assert.equal(await page.evaluate(() => fixtureDocument().items.find(item => item.kind === 'text').text), '引擎适配\n中文文字');
  assert.ok(await page.locator('[data-owned-culled="true"]').count() >= 220);
  assert.equal(await object('near-image').locator('image').getAttribute('href'), '/image.png');
  check('gzip-save-reopen-retains-all-226-records-camera-stacking-text-and-brush');

  assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.errors, []);
  report.passed = true;
})().catch(error => {report.passed = false; report.fatal = {stage, message: String(error.stack || error.message).slice(0, 1800)}; process.exitCode = 1;})
  .finally(async () => {
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
    const file = process.env.NOVART_ENGINE_REPORT || path.join(repo, '.novart-build', 'engine-browser-report.json');
    fs.writeFileSync(file, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    const resolved = path.resolve(directory); assert.equal(path.dirname(resolved), path.resolve(temporaryRoot));
    fs.rmSync(resolved, {recursive: true, force: true});
  });

/* Only the Python companion supplies private, temporary review-room access. */
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright-core');
const {mode, origin, port, entry, reportPath} = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.ok(['loopback-http', 'production-https'].includes(mode));
const production = mode === 'production-https';
assert.equal(origin, production ? `https://novart-canvas.test:${port}` : `http://127.0.0.1:${port}`);
const report = {mode, isolated: true, samples: [], crashLogs: [], controlledFrameRetry: false};
let browser;

async function structuralState(page) {
  return page.evaluate(() => {
    const frame = document.querySelector('.ns-frame-slot[data-active="true"] iframe');
    const win = frame?.contentWindow, doc = frame?.contentDocument;
    if (!doc || !win) return {frame: false};
    const state = {frame: true, path: win.location.pathname, protocol: win.location.protocol,
      canvas: !!doc.querySelector('[data-testid="canvas"]'), toolbar: !!doc.querySelector('[data-testid="bottom-toolbar"]'),
      ready: frame.dataset.ready, embedded: win.parent !== win,
      status: document.getElementById('ns-workspace-status')?.innerText || '',
      boundary: !!doc.querySelector('.tl-error-boundary'),
      crashMarker: doc.documentElement?.dataset.novartNativeFailure || null,
      licensePlaceholder: !!doc.querySelector('[data-testid="tl-license-expired"]'),
      placeholderDisplay: doc.querySelector('[data-testid="tl-license-expired"]')?.style.display || null,
      outerHeader: !!doc.getElementById('novart-bar'), controlled: !!win.navigator.serviceWorker.controller};
    // Read the real mounted SDK manager; never modify its state, key or clock.
    if (state.canvas && win.webpackChunk_lovartai_lovart_shell) {
      try {
        if (!win.__novartLicenseTestRead) win.webpackChunk_lovartai_lovart_shell.push([
          ['novart-local-license-read'], {}, require => {
            win.__novartLicenseTestRead = () => {
              const manager = require(37750).pW.getEditor().licenseManager;
              const payload = JSON.parse(win.atob(require(10938).$y.split('.')[0].split('/')[1]));
              return {licenseState: manager?.state.get(), isDevelopment: manager?.isDevelopment,
                licenseDomainMatches: payload[1].some(host => new RegExp('^' + host.toLowerCase()
                  .replace(/\./g, '\\.').replace(/\*/g, '.*') + '$').test(win.location.hostname.toLowerCase()))};
            };
          }
        ]);
        Object.assign(state, win.__novartLicenseTestRead?.());
      } catch { state.licenseState = 'unavailable'; }
    }
    return state;
  }).catch(error => {
    if (String(error.message).includes('Execution context was destroyed')) return {navigating: true};
    throw error;
  });
}

async function persistedProject(page) {
  return page.evaluate(async () => {
    const projectId = document.querySelector('.ns-frame-slot[data-active="true"] iframe')?.dataset.projectId;
    const response = await fetch('/api/canva/project/queryProject', {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({projectId})});
    const payload = await response.json();
    if (!response.ok || payload.code !== 0 || payload.data?.validProjectId !== true)
      throw Error('Synthetic project is not readable');
    return {projectId: payload.data.projectId, projectName: payload.data.projectName, canvas: payload.data.canvas};
  });
}

(async () => {
  browser = await chromium.launch({headless: true,
    ...(process.env.NOVART_CHROMIUM_EXECUTABLE ? {executablePath: process.env.NOVART_CHROMIUM_EXECUTABLE} : {}),
    proxy: {server: `http://127.0.0.1:${port}`, bypass: 'novart-canvas.test,127.0.0.1,localhost'},
    args: ['--host-resolver-rules=MAP novart-canvas.test 127.0.0.1', '--ignore-certificate-errors',
      '--disable-background-networking', '--disable-component-update']});
  const context = await browser.newContext({viewport: {width: 1366, height: 768}, locale: 'zh-CN',
    serviceWorkers: 'allow', ignoreHTTPSErrors: true});
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) return route.abort('blockedbyclient');
    return route.continue();
  });
  const page = await context.newPage();
  page.on('console', message => {
    const text = message.text();
    for (const prefix of ['[canvas-crash]', '[Lovart Shell] Failed to initialize:'])
      if (text.startsWith(prefix)) report.crashLogs.push(prefix);
  });
  await page.goto(origin + entry, {waitUntil: 'domcontentloaded'});
  await page.waitForURL('**/studio#/home', {timeout: 15000});
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {timeout: 15000});
  await page.locator('#ns-create-blank').click();
  await page.waitForURL('**/studio#/workspace/**');
  await page.waitForSelector('.ns-frame-slot[data-active="true"] iframe');
  const canvasPath = await page.locator('.ns-frame-slot[data-active="true"] iframe').getAttribute('src');
  let firstMounted = null, before = null;
  const start = Date.now();
  for (let i = 0; i < 150; i++) {
    const current = {elapsedMs: Date.now() - start, ...await structuralState(page)};
    report.samples.push(current);
    if (current.canvas && current.toolbar && !firstMounted) {
      firstMounted = current; before = await persistedProject(page);
    }
    if (production && current.licensePlaceholder) break;
    if (!production && firstMounted) {
      assert.equal(current.canvas, true); assert.equal(current.toolbar, true);
      assert.equal(current.licensePlaceholder, false); assert.equal(current.crashMarker, null);
      if (current.elapsedMs - firstMounted.elapsedMs >= 15000) break;
    }
    // A disposable self-signed HTTPS iframe can initially enter share-start
    // before clients.claim. Reopen the same fixture only after it is controlled.
    // This does not alter SDK initialization, its key, verification or rendering.
    if (!report.controlledFrameRetry && current.path === '/studio' && current.controlled) {
      report.controlledFrameRetry = true;
      await page.evaluate(url => {
        document.querySelector('.ns-frame-slot[data-active="true"] iframe').contentWindow.location.href = url;
      }, origin + canvasPath);
    }
    await page.waitForTimeout(250);
  }
  assert.ok(firstMounted, 'The actual native canvas and toolbar must first appear');
  const last = report.samples.at(-1);
  if (production) {
    assert.equal(firstMounted.isDevelopment, false);
    assert.equal(firstMounted.licenseState, 'unlicensed-production');
    assert.equal(firstMounted.licenseDomainMatches, false);
    assert.equal(last.canvas, false); assert.equal(last.toolbar, false);
    assert.equal(last.licensePlaceholder, true); assert.equal(last.placeholderDisplay, 'none');
    assert.equal(last.boundary, false); assert.equal(last.crashMarker, null); assert.equal(last.outerHeader, true);
    await page.waitForFunction(() => document.getElementById('ns-workspace-status')?.innerText.includes('此域名授权'));
    report.visibleRefusal = await page.locator('#ns-workspace-status').innerText();
    assert.equal(await page.locator('#ns-workspace-status button').count(), 1);
    assert.match(await page.locator('#ns-workspace-status button').innerText(), /返回项目库/);
    assert.equal(await page.locator('#ns-workspace-status').isVisible(), true);
    assert.equal((await structuralState(page)).ready, 'false');
    report.mountedToRemovedMs = last.elapsedMs - firstMounted.elapsedMs;
    assert.ok(report.mountedToRemovedMs >= 3500 && report.mountedToRemovedMs <= 10000);
    report.productionLicenseUsable = false;
    const diagnostics = await page.evaluate(async () => (await (await fetch('/review/startup-diagnostics')).json()).events);
    assert.ok(diagnostics.some(event => event.licenseRejected === true));
  } else {
    assert.equal(firstMounted.isDevelopment, true);
    assert.equal(last.ready, 'true');
    assert.ok(last.elapsedMs - firstMounted.elapsedMs >= 15000);
    report.stableForMs = last.elapsedMs - firstMounted.elapsedMs;
  }
  assert.deepEqual(report.crashLogs, []);
  assert.deepEqual(await persistedProject(page), before, 'License refusal must preserve the saved project and canvas');
  report.persistedProjectUnchanged = true;
  report.passed = true;
})().catch(error => {
  report.fatal = error.stack || String(error); process.exitCode = 1;
}).finally(async () => {
  await browser?.close(); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({mode, passed: report.passed || false, stableForMs: report.stableForMs,
    mountedToRemovedMs: report.mountedToRemovedMs, persistedProjectUnchanged: report.persistedProjectUnchanged,
    productionLicenseUsable: report.productionLicenseUsable, fatal: report.fatal || null}));
});

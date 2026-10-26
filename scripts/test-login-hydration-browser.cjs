/* Actual LoginPage SSR -> hydrateRoot regression in offline Chrome.
 * Only next-auth signIn is replaced: all accounts and POST endpoints are local
 * synthetic fixtures. This verifies UI lifecycle, not real Auth.js/backend auth.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright-core');

const repo = path.resolve(__dirname, '..');
const web = path.join(repo, 'apps/web');
const source = path.join(web, 'src/app/login/page.tsx');
const runId = String(Date.now());
const reportPath = process.env.NOVART_LOGIN_HYDRATION_REPORT || path.join(repo, '.novart-build/reports/login-hydration-' + runId + '.json');
const screenshots = path.join(path.dirname(reportPath), 'login-hydration-' + runId);
const temporaryRoot = path.join(repo, '.novart-build/temporary');
fs.mkdirSync(temporaryRoot, { recursive: true });
fs.mkdirSync(screenshots, { recursive: true });
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'login-hydration-'));
const priorEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, GOMAXPROCS: process.env.GOMAXPROCS };
process.env.TEMP = directory;
process.env.TMP = directory;
process.env.GOMAXPROCS = '2';
const synthetic = { email: 'ssr-fixture@invalid.example', password: 'synthetic-' + crypto.randomBytes(18).toString('hex') };
const callback = '/inspiration?workspaceId=ssr-isolated&kind=reference#saved';
const report = {
  passed: false, isolated: true, realComponent: 'apps/web/src/app/login/page.tsx',
  serverRenderer: 'react-dom/server.renderToString', clientRenderer: 'react-dom/client.hydrateRoot',
  realAuthentication: false, realBackend: false, realProvider: false,
  sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
  checks: [], errors: [], hydrationErrors: [], externalRequests: [], unexpectedRequests: [],
  credentialGetLeaks: [], syntheticSignInPosts: 0, forcedNativePosts: 0, screenshots: [],
};
let server, browser, activePage, origin, stage = 'compile', delayed = true;
let html, clientScript, pendingSignIns = [], pendingScripts = [], requests = [];
const check = message => report.checks.push(message);
const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
function leak(url) {
  const decoded = decodeURIComponent(url.href);
  return url.searchParams.has('email') || url.searchParams.has('password') || decoded.includes(synthetic.email) || decoded.includes(synthetic.password);
}
function releaseScripts() {
  delayed = false;
  for (const res of pendingScripts.splice(0)) if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(clientScript); }
}
function releaseSignIn(error) {
  assert.equal(pendingSignIns.length, 1, 'Exactly one synthetic signIn must be in flight');
  json(pendingSignIns.shift(), error ? { error: 'CredentialsSignin', status: 401 } : { error: null, ok: true, status: 200 }, error ? 401 : 200);
}
async function screenshot(page, name) {
  const filename = path.join(screenshots, name + '.png');
  // Default caret hiding temporarily edits input styles and can leave style=""
  // behind, creating an artificial React hydration warning in untouched SSR.
  await page.screenshot({ path: filename, fullPage: true, caret: 'initial' });
  report.screenshots.push(filename);
}
async function compile() {
  const packages = path.join(repo, 'node_modules/.pnpm');
  const installed = fs.readdirSync(packages).find(name => name.startsWith('esbuild@0.28.'));
  assert.ok(installed, 'Use the installed esbuild; no download');
  const esbuild = require(path.join(packages, installed, 'node_modules/esbuild'));
  const react = path.dirname(require.resolve('react/package.json', { paths: [web] }));
  const reactDom = path.dirname(require.resolve('react-dom/package.json', { paths: [web] }));
  const stub = path.join(directory, 'auth-stub.ts');
  fs.writeFileSync(stub, `export async function signIn(provider:string, options:Record<string,unknown>) {
    if(provider!=='password') throw new Error('Only synthetic password UI is in scope');
    const response=await fetch('/fixture/auth/signin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider,...options})});
    return response.json();
  }`);
  const ssr = path.join(directory, 'server.tsx');
  const client = path.join(directory, 'client.tsx');
  const component = JSON.stringify(source.replaceAll('\\', '/'));
  fs.writeFileSync(ssr, `import React from 'react';import {renderToString} from 'react-dom/server';import LoginPage from ${component};export function render(){return renderToString(<LoginPage/>);}`);
  fs.writeFileSync(client, `import React from 'react';import {hydrateRoot} from 'react-dom/client';import LoginPage from ${component};
    (window as any).__loginHydrationErrors=[];
    hydrateRoot(document.getElementById('login-root')!,<LoginPage/>,{onRecoverableError(error){(window as any).__loginHydrationErrors.push(String((error as Error).message));}});
    (window as any).__loginHydrateRootCalled=true;
  `);
  const common = {
    bundle: true, jsx: 'automatic', tsconfig: path.join(web, 'tsconfig.json'),
    nodePaths: [path.join(web, 'node_modules')], logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    alias: { react, 'react-dom': reactDom, '@brandai/ui': path.join(repo, 'packages/ui/src/index.ts'), 'next-auth/react': stub },
  };
  await esbuild.build({ ...common, entryPoints: [ssr], outfile: path.join(directory, 'server.cjs'), platform: 'node', format: 'cjs' });
  html = require(path.join(directory, 'server.cjs')).render();
  assert.match(html, /<form[^>]*method="post"/);
  assert.match(html, /id="login-email"[^>]*disabled=""/);
  assert.match(html, /id="login-password"[^>]*disabled=""/);
  assert.match(html, /正在准备登录/);
  assert.match(html, /<noscript>/);
  check('actual renderToString markup contains a POST form, disabled credential fields and noscript guidance');
  report.ssrHtmlBytes = Buffer.byteLength(html);
  await esbuild.build({ ...common, entryPoints: [client], outfile: path.join(directory, 'hydrate.js'), platform: 'browser', format: 'iife' });
  clientScript = fs.readFileSync(path.join(directory, 'hydrate.js'));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), report.sourceSha256, 'Login implementation must stay unchanged during both compilations');
  const css = spawnSync(process.execPath, [path.join(web, 'node_modules/tailwindcss/lib/cli.js'), '-i', path.join(repo, 'packages/ui/src/styles.css'), '-o', path.join(directory, 'tokens.css'), '-c', path.join(web, 'tailwind.config.ts'), '--content', [source, path.join(repo, 'packages/ui/src/**/*.{ts,tsx}')].join(',')], { cwd: repo, encoding: 'utf8', timeout: 60000 });
  assert.equal(css.status, 0, 'Product token CSS must compile: ' + css.stderr);
}
async function start() {
  await compile();
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const record = { method: req.method, path: url.pathname, queryKeys: [...url.searchParams.keys()], credentialsInUrl: leak(url) };
    requests.push(record);
    if (req.method === 'GET' && record.credentialsInUrl) report.credentialGetLeaks.push({ path: url.pathname, queryKeys: record.queryKeys });
    if (url.pathname === '/login' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tokens.css"><script defer src="/hydrate.js"></script></head><body><div id="login-root">' + html + '</div><aside style="position:fixed;bottom:4px;left:8px;font:11px sans-serif;background:white;padding:4px">离线交互自测 · 合成账号 · 非真实登录</aside></body></html>');
    }
    if (url.pathname === '/hydrate.js' && req.method === 'GET') {
      if (delayed) return pendingScripts.push(res);
      res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(clientScript);
    }
    if (url.pathname === '/tokens.css') { res.setHeader('Content-Type', 'text/css'); return res.end(fs.readFileSync(path.join(directory, 'tokens.css'))); }
    if (url.pathname === '/api/auth/providers' && req.method === 'GET') return json(res, {});
    if (url.pathname === '/api/auth/registration' && req.method === 'GET') return json(res, { registrationOpen: false });
    if (url.pathname === '/fixture/auth/signin' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      return req.on('end', () => {
        try {
          const value = JSON.parse(body);
          assert.deepEqual(value, { provider: 'password', email: synthetic.email, password: synthetic.password, redirect: false });
          report.syntheticSignInPosts++; pendingSignIns.push(res);
        } catch { report.errors.push({ stage, message: 'Unexpected synthetic signIn body' }); json(res, { error: 'FixtureContract' }, 400); }
      });
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      return req.on('end', () => {
        const form = new URLSearchParams(body);
        record.syntheticBodyMatches = form.get('email') === synthetic.email && form.get('password') === synthetic.password;
        record.callbackPreserved = url.searchParams.get('callbackUrl') === callback;
        report.forcedNativePosts++;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<p>合成原生 POST 已接收</p>');
      });
    }
    if (['/inspiration', '/studio'].includes(url.pathname) && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<h1>合成回调目的地</h1>'); }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    const assets = ['/brand/deepflare-logo.svg', '/brand/deepflare-logo-dark.svg', '/fonts/inter-latin-400.woff2', '/fonts/inter-latin-500.woff2', '/fonts/inter-latin-600.woff2'];
    if (assets.includes(url.pathname) && req.method === 'GET') {
      const file = path.join(web, 'public', url.pathname);
      if (fs.existsSync(file)) { res.setHeader('Content-Type', url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'font/woff2'); return res.end(fs.readFileSync(file)); }
    }
    report.unexpectedRequests.push({ method: req.method, path: url.pathname }); return json(res, { error: 'Unknown isolated route' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + server.address().port;
}
async function context(options) {
  const ctx = await browser.newContext({ locale: 'zh-CN', reducedMotion: 'reduce', serviceWorkers: 'block', ...options });
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { report.externalRequests.push(url.origin + url.pathname); return route.abort(); }
    return route.continue();
  });
  const page = await ctx.newPage(); activePage = page; page.setDefaultTimeout(7000);
  page.on('pageerror', error => report.errors.push({ stage, message: error.message }));
  page.on('console', message => { if (message.type() === 'error' && /hydration|hydrated|hydrating|server rendered|didn't match/i.test(message.text())) report.hydrationErrors.push({ stage, message: message.text() }); });
  return { ctx, page };
}
async function disabled(page, label) {
  const form = page.locator('form');
  await page.getByRole('heading', { name: '进入你的品牌视觉工作台', exact: true }).waitFor();
  assert.equal(await form.getAttribute('method'), 'post');
  for (const selector of ['#login-email', '#login-password', 'button[aria-controls="login-password"]', 'button[type="submit"]']) assert.equal(await page.locator(selector).isDisabled(), true, selector);
  const count = requests.length;
  await assert.rejects(page.locator('#login-email').fill(synthetic.email, { timeout: 250 }), /not enabled|disabled|Timeout/);
  await page.locator('button[type="submit"]').click({ force: true });
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#login-email').inputValue(), '');
  assert.equal(await page.locator('#login-password').inputValue(), '');
  assert.equal(requests.slice(count).some(r => r.method === 'POST' || r.credentialsInUrl), false);
  assert.equal(new URL(page.url()).pathname, '/login');
  check(label + ': credential fields, reveal and submit remain disabled; native input/click/Enter cannot send credentials');
}
async function pending() {
  const until = Date.now() + 5000;
  while (!pendingSignIns.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(pendingSignIns.length, 1, 'Synthetic POST reached the loopback service');
}

(async () => {
  origin = await start();
  browser = await chromium.launch({ executablePath: process.env.NOVART_CHROMIUM_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), headless: true, args: ['--disable-background-networking', '--no-proxy-server'] });
  const login = origin + '/login?' + new URLSearchParams({ callbackUrl: callback });
  for (const spec of [{ name: 'desktop', width: 1440, height: 960 }, { name: 'mobile', width: 390, height: 844 }]) {
    stage = spec.name + '-delayed-hydration'; delayed = true;
    const { ctx, page } = await context({ viewport: { width: spec.width, height: spec.height } });
    await page.goto(login, { waitUntil: 'commit' });
    await disabled(page, spec.name + ' SSR before hydration');
    assert.equal(pendingScripts.length, 1, 'The browser requested the hydration bundle and its response is still deliberately withheld');
    assert.equal(await page.evaluate(() => window.__loginHydrateRootCalled), undefined);
    await page.evaluate(() => { window.__ssrEmailNode = document.querySelector('#login-email'); });
    assert.equal(requests.filter(r => r.path === '/api/auth/providers').length, spec.name === 'desktop' ? 0 : 1);
    await screenshot(page, spec.name + '-ssr-disabled');
    releaseScripts();
    await page.getByRole('button', { name: '登录', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('#login-email').disabled);
    assert.equal(await page.evaluate(() => window.__loginHydrateRootCalled), true);
    assert.equal(await page.evaluate(() => document.querySelector('#login-email') === window.__ssrEmailNode), true, 'Hydration must reuse the actual server-rendered input rather than replace it with CSR');
    assert.equal(await page.locator('form').getAttribute('aria-busy'), 'false');
    report.hydrationErrors.push(...await page.evaluate(() => window.__loginHydrationErrors));
    assert.deepEqual(report.hydrationErrors, []);
    check(spec.name + ': real hydrateRoot reuses the same SSR input node without mismatch and enables the controls');
    await page.getByLabel('邮箱', { exact: true }).fill(synthetic.email);
    await page.getByLabel('密码', { exact: true }).fill(synthetic.password);
    await page.getByRole('button', { name: '显示密码', exact: true }).click();
    assert.equal(await page.locator('#login-password').getAttribute('type'), 'text');
    await page.getByRole('button', { name: '隐藏密码', exact: true }).click();
    const before = report.syntheticSignInPosts;
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await pending();
    assert.equal(await page.locator('#login-email').isDisabled(), true);
    assert.equal(await page.locator('#login-password').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '显示密码', exact: true }).isDisabled(), true);
    await page.locator('button[type="submit"]').click({ force: true });
    assert.equal(report.syntheticSignInPosts, before + 1);
    releaseSignIn(true);
    await page.getByRole('alert').filter({ hasText: '邮箱或密码不正确' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '登录', exact: true }).isEnabled(), true);
    assert.equal(await page.locator('#login-email').inputValue(), synthetic.email);
    assert.equal(await page.locator('#login-password').inputValue(), synthetic.password);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await screenshot(page, spec.name + '-retry-ready');
    check(spec.name + ': one synthetic POST during loading; failure restores inputs and retry without a credential GET');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await pending();
    const redirected = page.waitForURL(origin + callback);
    releaseSignIn(false);
    await redirected;
    assert.equal(page.url(), origin + callback);
    assert.equal(report.syntheticSignInPosts, before + 2);
    check(spec.name + ': successful retry preserves the callback path, query and hash');
    await ctx.close(); activePage = undefined;
  }
  stage = 'javascript-disabled'; delayed = true;
  const { ctx, page } = await context({ javaScriptEnabled: false, viewport: { width: 1440, height: 960 } });
  await page.goto(login, { waitUntil: 'domcontentloaded' });
  await disabled(page, 'JavaScript disabled');
  await page.getByText('登录需要启用 JavaScript。请启用后刷新页面。', { exact: true }).waitFor();
  await screenshot(page, 'no-javascript-disabled');
  check('JavaScript disabled: real SSR noscript guidance is visible and the login form stays locked');
  stage = 'forced-synthetic-native-fallback';
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await page.evaluate(values => {
    // Fault injection in this disposable synthetic page only. This intentionally
    // bypasses disabled controls to inspect the browser's native form transport.
    for (const name of ['email', 'password']) { const input = document.querySelector(`input[name="${name}"]`); input.disabled = false; input.value = values[name]; }
    HTMLFormElement.prototype.submit.call(document.querySelector('form'));
  }, synthetic);
  await navigation;
  const native = requests.filter(r => r.method === 'POST' && r.path === '/login');
  assert.equal(native.length, 1); assert.equal(native[0].syntheticBodyMatches, true); assert.equal(native[0].callbackPreserved, true); assert.equal(native[0].credentialsInUrl, false);
  assert.equal(page.url(), login);
  check('forced synthetic native fallback submits a POST body, preserves callbackUrl and never places credentials in the URL');
  await ctx.close(); activePage = undefined;
  assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.unexpectedRequests, []); assert.deepEqual(report.errors, []); assert.deepEqual(report.credentialGetLeaks, []);
  assert.equal(report.syntheticSignInPosts, 4); assert.equal(report.forcedNativePosts, 1);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), report.sourceSha256, 'Do not modify the login implementation during QA');
  check('all requests stayed on loopback; zero credential-bearing GETs, browser exceptions or hydration mismatches');
  report.passed = true;
})().catch(async error => {
  report.fatal = { stage, message: error.message, stack: error.stack };
  process.exitCode = 1;
  if (activePage && !activePage.isClosed()) await screenshot(activePage, 'failure').catch(() => {});
}).finally(async () => {
  releaseScripts();
  for (const response of pendingSignIns.splice(0)) if (!response.destroyed) json(response, { error: 'FixtureClosed' }, 503);
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  for (const [key, value] of Object.entries(priorEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(temporaryRoot));
  assert.ok(path.basename(directory).startsWith('login-hydration-'));
  fs.rmSync(directory, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, syntheticSignInPosts: report.syntheticSignInPosts, forcedNativePosts: report.forcedNativePosts, credentialGetLeaks: report.credentialGetLeaks.length, reportPath, screenshots, fatal: report.fatal }, null, 2));
});

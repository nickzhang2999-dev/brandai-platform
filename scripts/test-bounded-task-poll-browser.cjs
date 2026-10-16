/* Real React + Chromium on loopback, synthetic HTTP receipts only. No database,
 * accounts, provider calls, external browser state or remote deployment. */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const repo = path.resolve(__dirname, '..');
const build = path.join(repo, '.novart-build', 'temporary'); fs.mkdirSync(build, { recursive: true });
const directory = fs.mkdtempSync(path.join(build, 'bounded-poll-'));
const esbuildDir = fs.readdirSync(path.join(repo, 'node_modules/.pnpm')).find(name => name.startsWith('esbuild@0.28.'));
const esbuild = require(path.join(repo, 'node_modules/.pnpm', esbuildDir, 'node_modules/esbuild'));
const report = { isolated: true, realBackend: false, realProvider: false, providerCalls: 0, checks: [], errors: [], externalRequests: [] };
const counts = {}, states = {}, requests = [];
let browser, server, base, held;
const file = name => path.join(repo, name).replaceAll('\\', '/');
async function main() {
  const entry = path.join(directory, 'entry.tsx');
  fs.writeFileSync(entry, `import React,{useState} from '${file('apps/web/node_modules/react')}';
import {createRoot} from '${file('apps/web/node_modules/react-dom/client')}';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {useBoundedTaskQuery} from '${file('apps/web/src/lib/use-bounded-task-poll')}';
import {TextChecker} from '${file('apps/web/src/app/(app)/workspaces/[wsId]/compliance/text-checker')}';
import {GenerateWizard} from '${file('apps/web/src/app/(app)/workspaces/[wsId]/generate/generate-wizard')}';
function Probe(){const [id,setId]=useState('a'),[ws,setWs]=useState('first'),[tick,setTick]=useState(0);
const task=useBoundedTaskQuery({queryKey:['probe',ws,id],taskKey:JSON.stringify([ws,id]),intervalMs:1000,
queryFn:async(signal)=>{const r=await fetch('/probe/'+ws+'/'+id,{signal});if(!r.ok)throw new Error('controlled read error');return r.json()},getStatus:(data:any)=>data?.status});
return <div><output data-testid="probe-state">{JSON.stringify({id,ws,tick,paused:task.timedOut,status:task.data?.status,result:task.data?.result,error:!!task.error})}</output>
<button onClick={()=>setTick(tick+1)}>rerender</button><button onClick={task.resume}>resume</button><button onClick={()=>setId('b')}>new task</button>
<button onClick={()=>setWs('second')}>new workspace</button><button onClick={()=>setId('held')}>slow task</button><button onClick={()=>setId('failed-read')}>failed read</button></div>}
const qc=new QueryClient({defaultOptions:{queries:{retry:false}}});
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={qc}>{location.pathname==='/checker'?<TextChecker wsId="first"/>:location.pathname==='/wizard'?<GenerateWizard wsId="first" initialProjects={[]} confirmedRuleCount={0} myRole="OWNER"/>:<Probe/>}</QueryClientProvider>);`);
  await esbuild.build({ entryPoints: [entry], outfile: path.join(directory, 'app.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', tsconfig: path.join(repo, 'apps/web/tsconfig.json'), nodePaths: [path.join(repo, 'apps/web/node_modules')], define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'silent' });
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname; requests.push([req.method, pathname]);
    const json = value => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (pathname === '/app.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(fs.readFileSync(path.join(directory, 'app.js'))); }
    if (pathname.startsWith('/probe/')) {
      counts[pathname] = (counts[pathname] || 0) + 1;
      if (pathname.endsWith('/held')) { const pending = { res, aborted: false }; held = pending; res.on('close', () => { pending.aborted = true; }); return; }
      if (states[pathname]?.statusCode) { res.writeHead(states[pathname].statusCode, { 'content-type': 'application/json' }); return res.end('{}'); }
      return json(states[pathname] || { status: 'RUNNING', result: pathname });
    }
    if (pathname === '/api/workspaces/first/compliance/precheck') { res.writeHead(202, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ taskId: 'check-one', status: 'PENDING' })); }
    if (pathname === '/api/workspaces/first/tasks/check-one') {
      counts[pathname] = (counts[pathname] || 0) + 1;
      return json(states[pathname] || { id: 'check-one', status: 'RUNNING', progress: 30 });
    }
    if (pathname === '/api/workspaces/first/projects') return json([]);
    if (pathname === '/api/workspaces/first/generations/gen-one') return json({ generation: { id: 'gen-one', status: 'RUNNING', versions: [] } });
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body><div id="root"></div><script>window.process={env:{}}</script><script src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, ...(process.env.NOVART_CHROMIUM_EXECUTABLE ? { executablePath: process.env.NOVART_CHROMIUM_EXECUTABLE } : {}), args: ['--disable-background-networking'] });
  const page = await browser.newPage();
  await page.route('**/*', route => { if (new URL(route.request().url()).origin !== base) { report.externalRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.clock.install({ time: new Date('2026-10-16T00:00:00Z') }); await page.goto(base);
  const state = async () => JSON.parse(await page.getByTestId('probe-state').textContent());
  await page.waitForFunction(() => document.querySelector('output')?.textContent.includes('RUNNING'));
  await page.clock.fastForward(5 * 60_000); await page.getByRole('button', { name: 'rerender', exact: true }).click();
  await page.clock.fastForward(60_001); await page.waitForFunction(() => document.querySelector('output')?.textContent.includes('"paused":true'));
  const stopped = counts['/probe/first/a']; await page.clock.fastForward(60_000); assert.equal(counts['/probe/first/a'], stopped);
  report.checks.push('six-minute-stop-survives-rerender-and-does-not-repeat-GET');
  await page.getByRole('button', { name: 'resume', exact: true }).click(); await page.waitForFunction(() => document.querySelector('output')?.textContent.includes('"paused":false'));
  await page.waitForTimeout(30); assert.ok(counts['/probe/first/a'] > stopped); assert.equal(requests.filter(([method]) => method === 'POST').length, 0);
  report.checks.push('manual-resume-reads-same-task-without-post');
  states['/probe/first/failed-read'] = { statusCode: 503 };
  await page.getByRole('button', { name: 'failed read', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('output')?.textContent.includes('"error":true'));
  states['/probe/first/failed-read'] = { status: 'SUCCEEDED', result: 'read-recovered' };
  await page.getByRole('button', { name: 'resume', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('output')?.textContent.includes('read-recovered'));
  assert.equal(counts['/probe/first/failed-read'], 2);
  report.checks.push('manual-resume-after-read-error-immediately-GETs-once');
  states['/probe/first/b'] = { status: 'SUCCEEDED', result: 'terminal-b' };
  await page.getByRole('button', { name: 'new task', exact: true }).click(); await page.waitForFunction(() => document.querySelector('output')?.textContent.includes('terminal-b'));
  const terminalReads = counts['/probe/first/b']; await page.clock.fastForward(7 * 60_000);
  await page.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); });
  assert.equal(counts['/probe/first/b'], terminalReads); assert.equal((await state()).paused, false);
  report.checks.push('terminal-stops-automatically-and-wins-over-observation-timeout');
  await page.getByRole('button', { name: 'slow task', exact: true }).click(); await page.waitForTimeout(30); assert.ok(held);
  const oldHeld = held;
  await page.getByRole('button', { name: 'new workspace', exact: true }).click(); await page.waitForTimeout(30);
  assert.ok(oldHeld.aborted); // The prior Query observer consumed its AbortSignal.
  states['/probe/second/b'] = { status: 'SUCCEEDED', result: 'second-workspace' };
  await page.getByRole('button', { name: 'new task', exact: true }).click(); await page.waitForFunction(() => document.querySelector('output')?.textContent.includes('second-workspace'));
  assert.equal((await state()).ws, 'second');
  report.checks.push('workspace-switch-aborts-old-read-and-isolates-result');
  await page.goto(base + '/checker'); await page.getByRole('textbox').fill('synthetic test copy');
  await page.getByRole('button', { name: '运行校验', exact: true }).click(); await page.getByText('校验已受理，可离开后从队列查看。', { exact: false }).waitFor();
  const posts = requests.filter(([method, pathname]) => method === 'POST' && pathname.endsWith('/precheck')).length; assert.equal(posts, 1);
  await page.clock.fastForward(6 * 60_000 + 1); await page.getByRole('button', { name: '继续查询原任务', exact: true }).waitFor();
  states['/api/workspaces/first/tasks/check-one'] = { id: 'check-one', status: 'FAILED', progress: 100, error: 'synthetic controlled failure' };
  await page.getByRole('button', { name: '继续查询原任务', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'synthetic controlled failure' }).waitFor();
  assert.equal(requests.filter(([method, pathname]) => method === 'POST' && pathname.endsWith('/precheck')).length, 1);
  report.checks.push('production-precheck-component-202-polls-result-and-resumes-without-resubmit');
  states['/api/workspaces/first/tasks/check-one'] = { id: 'check-one', status: 'SUCCEEDED', progress: 100, result: { report: { overall: 'RISK', textResults: [{ level: 'RISK', reason: 'synthetic persisted report', replacement: 'safer fixture text' }], visualResults: [], checkedAt: '2026-10-16T00:00:00.000Z' } } };
  await page.goto(base + '/checker'); await page.getByRole('textbox').fill('second explicit synthetic check');
  await page.getByRole('button', { name: '运行校验', exact: true }).click();
  await page.getByText('synthetic persisted report', { exact: true }).waitFor();
  const successfulReads = counts['/api/workspaces/first/tasks/check-one'];
  await page.clock.fastForward(7 * 60_000);
  assert.equal(counts['/api/workspaces/first/tasks/check-one'], successfulReads);
  report.checks.push('production-precheck-displays-persisted-result-and-stops-at-success');
  await page.goto(base + '/wizard?gen=gen-one');
  await page.getByRole('button', { name: '重新生成', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '重新生成', exact: true }).isDisabled(), true);
  await page.clock.fastForward(6 * 60_000 + 1);
  await page.getByRole('button', { name: '继续查询原任务', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '重新生成', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '新建一次生成', exact: true }).isDisabled(), true);
  assert.equal(await page.getByText('生成中 ·', { exact: false }).count(), 0);
  await page.getByRole('button', { name: '继续查询原任务', exact: true }).click();
  assert.equal(requests.filter(([method, pathname]) => method === 'POST' && pathname.includes('/generations')).length, 0);
  report.checks.push('production-wizard-pause-keeps-paid-actions-locked-without-spinner-or-auto-submit');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
}
main().catch(error => { report.failure = error.stack || String(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close(); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const output = process.env.NOVART_BOUNDED_POLL_REPORT; if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});

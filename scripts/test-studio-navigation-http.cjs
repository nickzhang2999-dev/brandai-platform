/* Real Next middleware over loopback, without database, login, or AI calls. */
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '..');
const web = path.join(repo, 'apps/web');
const requireWeb = createRequire(path.join(web, 'package.json'));
let child;
const report = { realNextServer: true, realDatabase: false, realAuthentication: false, providerCalls: 0, checks: [] };
(async () => {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  child = spawn(process.execPath, [requireWeb.resolve('next/dist/bin/next'), 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: web, windowsHide: true, stdio: 'ignore', env: { ...process.env,
      NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
      DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/synthetic',
      REDIS_URL: 'redis://127.0.0.1:1', AI_SERVICE_URL: 'http://127.0.0.1:1',
      AUTH_SECRET: 'local-navigation-test-only-not-a-real-account',
    },
  });
  child.on('error', error => { report.processError = error.message; });
  const origin = `http://127.0.0.1:${port}`;
  const get = url => fetch(origin + url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if ((await get('/workspace')).status === 307) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'local built Next server starts');
  for (const [old, expected] of [
    ['/', '/studio'], ['/workspace', '/studio#/projects'],
    ['/workspace?workspaceId=w&project=p', '/studio-editor?workspaceId=w&projectId=p'],
    ['/workspaces/w/assets', '/assets?workspaceId=w'],
    ['/workspaces/w/rules', '/brand-knowledge?workspaceId=w'],
    ['/workspaces/w/members', '/members?workspaceId=w'],
    ['/workspaces/w/projects', '/campaigns?workspaceId=w'],
    ['/workspaces/w/projects/p', '/studio-editor?workspaceId=w&projectId=p'],
    ['/workspaces/w/generations/g/versions/v/edit', '/generated?workspaceId=w&generationId=g&versionId=v'],
  ]) {
    const response = await get(old);
    assert.equal(response.status, 307, old);
    const location = new URL(response.headers.get('location'));
    // Next normalizes numeric loopback hosts to localhost in middleware.
    assert.ok(['127.0.0.1', 'localhost'].includes(location.hostname));
    assert.equal(location.port, String(port));
    assert.equal(location.pathname + location.search + location.hash, expected, old);
    report.checks.push(old);
  }
  for (const target of ['/studio-editor?workspaceId=w&projectId=p', '/account?workspaceId=w', '/assets?workspaceId=w']) {
    const response = await get(target);
    assert.equal(response.status, 307, target);
    const location = new URL(response.headers.get('location'));
    assert.equal(location.pathname, '/login');
    assert.equal(location.searchParams.get('callbackUrl'), target);
    report.checks.push('authenticated-target:' + target);
  }
  report.passed = true;
})().catch(error => { report.passed = false; report.error = error.message; process.exitCode = 1; }).finally(() => {
  if (child && child.exitCode === null) child.kill();
  const output = path.join(repo, '.novart-build/p4-routing-http.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
});

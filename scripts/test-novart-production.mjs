import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { verifyArtifacts, verifyHealth, verifyServed, verifyReleaseIdentity } from '../deploy/novart/production/verify.mjs';

const sha = '1'.repeat(40);
const hash = body => createHash('sha256').update(body).digest('hex');

test('production publishing remains restricted to main and a full commit', () => {
  assert.doesNotThrow(() => verifyReleaseIdentity({CDS_BRANCH_NAME:'main',CDS_COMMIT_SHA:sha}));
  assert.throws(() => verifyReleaseIdentity({CDS_BRANCH_NAME:'feature',CDS_COMMIT_SHA:sha}), /Only main/);
  assert.throws(() => verifyReleaseIdentity({CDS_BRANCH_NAME:'main',CDS_COMMIT_SHA:'1234567'}), /complete release commit/);
});
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'novart-production-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bodies = { '/studio.html': '<html>owned</html>', '/new-resource.js': 'console.log(1)' };
  const manifest = { format: 'novart-studio-assets-v1', files: {} };
  for (const [url, body] of Object.entries(bodies)) {
    await writeFile(path.join(root, url.slice(1)), body);
    manifest.files[url] = { file: url.slice(1), bytes: Buffer.byteLength(body), sha256: hash(body),
      mime: url.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript' };
  }
  const save = () => writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  await save();
  return { root, bodies, manifest, save };
}

test('a new manifest is valid after retiring the legacy service worker', async t => {
  const f = await fixture(t);
  assert.deepEqual(await verifyArtifacts(f.root), f.manifest);
  assert.equal('/novart-product-worker.js' in f.manifest.files, false);
});

test('corrupt and missing resources identify the failing asset', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'new-resource.js'), 'corrupt');
  await assert.rejects(verifyArtifacts(f.root), /checksum mismatch: \/new-resource.js/);
  await rm(path.join(f.root, 'new-resource.js'));
  await assert.rejects(verifyArtifacts(f.root), /ENOENT/);
});

test('path traversal and symlinks cannot validate files outside the image assets', async t => {
  const f = await fixture(t);
  const outside = f.root + '-outside.js';
  f.manifest.files['/escape.js'] = { ...f.manifest.files['/new-resource.js'], file: '../' + path.basename(outside) };
  await writeFile(outside, 'outside');
  t.after(() => rm(outside, { force: true }));
  await f.save();
  await assert.rejects(verifyArtifacts(f.root), /escapes artifact root/);
  f.manifest.files['/escape.js'].file = 'link.js';
  await symlink(outside, path.join(f.root, 'link.js'));
  await f.save();
  await assert.rejects(verifyArtifacts(f.root), /escapes artifact root/);
});

test('missing shell entry cannot pass manifest verification', async t => {
  const f = await fixture(t);
  delete f.manifest.files['/studio.html'];
  await f.save();
  await assert.rejects(verifyArtifacts(f.root), /entry is missing/);
});

test('served resources, worker commit and queue must all match the release', async t => {
  const f = await fixture(t);
  const previous = process.env.CDS_COMMIT_SHA;
  const previousBranch = process.env.CDS_BRANCH_NAME;
  process.env.CDS_COMMIT_SHA = sha;
  process.env.CDS_BRANCH_NAME = 'main';
  t.after(() => { if (previous === undefined) delete process.env.CDS_COMMIT_SHA; else process.env.CDS_COMMIT_SHA = previous; });
  t.after(() => { if (previousBranch === undefined) delete process.env.CDS_BRANCH_NAME; else process.env.CDS_BRANCH_NAME = previousBranch; });
  const health = { web: 'ok', ai: 'ok', queuePrefix: 'brandai-prod',
    worker: { worker: 'ok', commit: sha.slice(0, 12), queuePrefix: 'brandai-prod' } };
  let served = f.bodies['/new-resource.js'];
  const server = createServer((req, res) => {
    if (req.url === '/api/health') res.end(JSON.stringify(health));
    else if (req.url === '/new-resource.js') res.end(served);
    else { res.writeHead(401); res.end('authenticated HTML'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await verifyServed(origin, f.root), 1);
  served = 'stale asset';
  await assert.rejects(verifyServed(origin, f.root), /checksum mismatch: \/new-resource.js/);
  health.worker.commit = '0'.repeat(12);
  await assert.rejects(verifyHealth(origin), /release commit/);
  health.worker.commit = sha.slice(0, 12);
  health.worker.queuePrefix = 'preview';
  await assert.rejects(verifyHealth(origin), /production queue mismatch/);
  health.worker.queuePrefix = 'brandai-prod';
  health.ai = 'down';
  await assert.rejects(verifyHealth(origin), /not ready/);
});

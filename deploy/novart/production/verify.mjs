import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = body => createHash('sha256').update(body).digest('hex');

export function verifyReleaseIdentity(env = process.env) {
  if (!/^[a-f0-9]{40}$/.test(env.CDS_COMMIT_SHA ?? '')) throw new Error('A complete release commit is required');
  if (env.CDS_BRANCH_NAME !== 'main') throw new Error('Only main may publish to NovartLab production');
}

export async function verifyArtifacts(directory = '/app/.novart-build/studio') {
  const root = await realpath(directory);
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'novart-studio-assets-v1' || !manifest.files ||
      !Object.hasOwn(manifest.files, '/studio.html')) {
    throw new Error('Studio manifest or /studio.html entry is missing');
  }
  for (const [url, entry] of Object.entries(manifest.files)) {
    if (!url.startsWith('/') || typeof entry?.file !== 'string' ||
        path.isAbsolute(entry.file)) throw new Error(`Invalid resource path: ${url}`);
    const filename = await realpath(path.resolve(root, entry.file));
    if (!filename.startsWith(root + path.sep)) throw new Error(`Resource escapes artifact root: ${url}`);
    const body = await readFile(filename);
    if (body.length !== entry.bytes || digest(body) !== entry.sha256) {
      throw new Error(`Studio resource size/checksum mismatch: ${url}`);
    }
  }
  return manifest;
}

async function request(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (!response.ok) throw new Error(`Resource HTTP ${response.status}: ${new URL(url).pathname}`);
  return response;
}

export async function verifyHealth(origin, workerOnly = false) {
  verifyReleaseIdentity();
  const expected = process.env.CDS_COMMIT_SHA;
  const body = await (await request(origin + (workerOnly ? '/' : '/api/health'))).json();
  const worker = workerOnly ? body : body.worker;
  if (worker?.worker !== 'ok' || worker.commit !== expected.slice(0, 12) ||
      worker.queuePrefix !== 'brandai-prod') throw new Error('Worker readiness, release commit or production queue mismatch');
  if (!workerOnly && (body.web !== 'ok' || body.ai !== 'ok' || body.queuePrefix !== 'brandai-prod')) {
    throw new Error('Web/AI/production queue is not ready');
  }
}

export async function verifyServed(origin, directory) {
  const manifest = await verifyArtifacts(directory);
  await verifyHealth(origin);
  let count = 0;
  for (const [url, entry] of Object.entries(manifest.files)) {
    // The authenticated HTML entry is checked above; public assets must match
    // this exact image, including any future additions or retirements.
    if (entry.mime?.startsWith('text/html')) continue;
    const response = await request(new URL(url, origin));
    if (digest(Buffer.from(await response.arrayBuffer())) !== entry.sha256) {
      throw new Error(`Served Studio resource checksum mismatch: ${url}`);
    }
    count++;
  }
  if (!count) throw new Error('Studio manifest has no public resources');
  return count;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    verifyReleaseIdentity();
    const mode = process.argv[2];
    if (mode === 'artifacts') {
      const manifest = await verifyArtifacts();
      console.log(`Studio artifact verification passed: ${Object.keys(manifest.files).length} resources`);
    } else if (mode === 'worker') {
      await verifyHealth('http://127.0.0.1:3001', true);
    } else if (mode === 'health') {
      await verifyHealth('http://127.0.0.1:3000');
    } else if (mode === 'served') {
      const count = await verifyServed(process.env.NOVART_VERIFY_ORIGIN ?? 'http://web:3000');
      console.log(`Release ${process.env.CDS_RELEASE_ID}: ${count} served resources verified`);
    } else throw new Error('Unknown production verification mode');
  } catch (error) {
    console.error(`Production release blocked: ${error.message}`);
    process.exitCode = 1;
  }
}

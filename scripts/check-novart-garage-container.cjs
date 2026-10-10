#!/usr/bin/env node
'use strict';

// Real, disposable Garage acceptance. No provider, production credentials or
// project storage are used. --static-check never invokes Docker or the network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '..');
const BASE_IMAGE = 'dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020';
const REPORT = path.join(ROOT, 'apps/web/.novart-ui-artifacts/garage-container.json');
const STAGES = new Set(['guard', 'image', 'create', 'ready', 'admin-auth', 'permissions', 's3-roundtrip', 's3-denials', 'recreate', 'durability', 'cleanup', 'complete', 'deadline']);
const report = { ok: false, realObjectStorage: true, realProvider: false, realProductUpload: false, stage: 'guard', checks: {} };
let stage = 'guard';
function check(condition) { if (!condition) throw new Error('GARAGE_ACCEPTANCE_FAILED'); }
function mark(value) { check(STAGES.has(value)); stage = value; report.stage = value; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function writeReport() {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
}
function staticCheck() {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'deploy/novart/storage/Dockerfile'), 'utf8');
  const toml = fs.readFileSync(path.join(ROOT, 'deploy/novart/storage/garage.toml'), 'utf8');
  check(dockerfile.startsWith(`FROM ${BASE_IMAGE}\n`));
  check(dockerfile.includes('COPY garage.toml /etc/garage.toml'));
  check(dockerfile.includes('CMD ["/garage", "-c", "/etc/garage.toml", "server", "--single-node"]'));
  check(dockerfile.includes('HEALTHCHECK ') && dockerfile.includes('"health", "--quiet"]'));
  check(!/^\s*(?:RUN|ENTRYPOINT|ENV)\s/im.test(dockerfile));
  check(!/--default-(?:bucket|access-key)|EXPOSE[^\n]*3903/.test(dockerfile));
  check(/\[admin\]\s+api_bind_addr\s*=\s*"0\.0\.0\.0:3903"/.test(toml));
  check(!/^\s*(?:admin_token|rpc_secret|metrics_token)\s*=/m.test(toml));
  return { ok: true, staticOnly: true, dockerInvoked: false, networkInvoked: false, runtimeVerified: false };
}

async function run() {
  staticCheck();
  check(process.env.CI === 'true' && process.platform === 'linux');
  const commit = process.env.COMMIT_SHA || '';
  const image = process.env.STORAGE_IMAGE || '';
  const network = process.env.NOVART_GARAGE_NETWORK || '';
  const anchor = process.env.NOVART_GARAGE_NETWORK_ANCHOR || '';
  check(/^[0-9a-f]{40}$/.test(commit));
  check(new RegExp(`^ghcr\\.io/[a-z0-9_.-]+/[a-z0-9_.-]+/novart-product-storage:sha-${commit}$`).test(image));
  check(/^[a-zA-Z0-9_.-]{1,160}$/.test(network) && /^[0-9a-f]{12,64}$/.test(anchor));
  report.commitSha = commit;
  const suffix = crypto.randomBytes(10).toString('hex');
  const name = `novart-ci-garage-${suffix}`;
  const volumeNames = [`${name}-meta`, `${name}-data`];
  const label = `novart.garage-ci=${suffix}`;
  let tempDirectory;
  let imageId;
  let client;
  let cleanupDone = false;
  function docker(args, optional = false) {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    if (result.error || result.status !== 0) {
      if (!result.error && optional && /no such (?:container|volume|object)/i.test(result.stderr || '')) return null;
      throw new Error('DOCKER_COMMAND_FAILED');
    }
    return result.stdout.trim();
  }
  function inspect(kind, id, optional = false) {
    const text = docker([kind, 'inspect', id], optional);
    if (text === null) return null;
    const result = JSON.parse(text);
    check(Array.isArray(result) && result.length === 1);
    return result[0];
  }
  function cleanup() {
    if (cleanupDone) return true;
    cleanupDone = true;
    let ok = true;
    try {
      const existing = inspect('container', name, true);
      if (existing) {
        check(existing.Config.Labels['novart.garage-ci'] === suffix);
        docker(['container', 'rm', '-f', name]);
      }
    } catch { ok = false; }
    for (const volume of volumeNames) {
      try {
        const existing = inspect('volume', volume, true);
        if (existing) {
          check(existing.Labels['novart.garage-ci'] === suffix);
          docker(['volume', 'rm', volume]);
        }
      } catch { ok = false; }
    }
    try { if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true }); } catch { ok = false; }
    return ok;
  }
  function emergencyExit() {
    mark('deadline'); report.errorType = 'TimeoutError';
    report.checks.cleanup = cleanup(); writeReport();
    process.stdout.write(JSON.stringify({ ok: false, stage: 'deadline', errorType: 'TimeoutError' }) + '\n');
    process.exit(1);
  }
  const requireWeb = createRequire(path.join(ROOT, 'apps/web/package.json'));
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, CreateBucketCommand, ListObjectsV2Command } = requireWeb('@aws-sdk/client-s3');
  const timer = setTimeout(emergencyExit, 300_000);
  process.once('SIGTERM', emergencyExit);
  process.once('SIGINT', emergencyExit);
  const rpc = crypto.randomBytes(32).toString('hex');
  const adminToken = crypto.randomBytes(32).toString('hex');
  let origin;
  async function request(endpoint, body, authorization = adminToken) {
    const response = await fetch(`${origin}:3903/v2/${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();
    check(text.length <= 1024 * 1024);
    return { status: response.status, data: response.ok ? JSON.parse(text) : null };
  }
  async function admin(endpoint, body) {
    const result = await request(endpoint, body);
    check(result.status === 200); return result.data;
  }
  async function waitReady() {
    const end = Date.now() + 75_000;
    while (Date.now() < end) {
      const current = inspect('container', name);
      check(current.State.Running === true);
      try {
        const health = await admin('GetClusterHealth');
        if (health.status === 'healthy' && health.storageNodes === 1 && health.storageNodesUp === 1 && current.State.Health?.Status === 'healthy') return;
      } catch { /* Only bounded, read-only health checks are retried. */ }
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    throw new Error('GARAGE_NOT_READY');
  }
  function start() {
    docker(['run', '-d', '--pull', 'never', '--name', name, '--label', label,
      '--network', network, '--network-alias', 'novart-storage', '--env-file', path.join(tempDirectory, 'runtime.env'),
      '--mount', `type=volume,source=${volumeNames[0]},target=/var/lib/garage/meta`,
      '--mount', `type=volume,source=${volumeNames[1]},target=/var/lib/garage/data`, image]);
    const container = inspect('container', name);
    check(container.Image === imageId);
    check(Object.keys(container.HostConfig.PortBindings || {}).length === 0);
    check(container.Mounts.length === 2 && container.Mounts.every(mount => mount.Type === 'volume' && volumeNames.includes(mount.Name)));
    check(!container.Mounts.some(mount => mount.Destination === '/etc/garage.toml'));
    const attachment = Object.values(container.NetworkSettings.Networks).find(value => value.NetworkID === network || container.NetworkSettings.Networks[network] === value);
    check(attachment && net.isIPv4(attachment.IPAddress));
    origin = `http://${attachment.IPAddress}`;
    report.checks.noPublishedPorts = true; report.checks.configBakedInImage = true;
  }
  async function send(command) { return client.send(command, { abortSignal: AbortSignal.timeout(15_000) }); }
  async function expectStatus(command, status) {
    try { await send(command); } catch (error) { check(error?.$metadata?.httpStatusCode === status); return; }
    throw new Error('EXPECTED_STORAGE_REJECTION');
  }
  function connect(credentials) {
    client?.destroy();
    client = new S3Client({ endpoint: `${origin}:3900`, region: 'garage', forcePathStyle: true, credentials, maxAttempts: 1 });
  }
  async function checkKey(keyId, bucketId) {
    const current = await admin(`GetKeyInfo?id=${encodeURIComponent(keyId)}&showSecretKey=false`);
    check(current.accessKeyId === keyId && current.expired === false && current.permissions.createBucket === false);
    check(current.buckets.length === 1 && current.buckets[0].id === bucketId);
    const permission = current.buckets[0].permissions;
    check(permission.read === true && permission.write === true && permission.owner === false);
    const bucket = await admin(`GetBucketInfo?id=${encodeURIComponent(bucketId)}`);
    check(bucket.websiteAccess === false && bucket.keys.length === 1 && bucket.keys[0].accessKeyId === keyId);
    check(bucket.keys[0].permissions.owner === false);
  }
  try {
    mark('image');
    const networkInfo = inspect('network', network);
    check(Object.keys(networkInfo.Containers || {}).some(id => id === anchor || id.startsWith(anchor)));
    const built = inspect('image', image);
    check(built.Config.Labels['org.opencontainers.image.revision'] === commit);
    check(JSON.stringify(built.Config.Cmd) === JSON.stringify(['/garage', '-c', '/etc/garage.toml', 'server', '--single-node']));
    check(JSON.stringify(built.Config.Healthcheck.Test) === JSON.stringify(['CMD', '/garage', '-c', '/etc/garage.toml', 'health', '--quiet']));
    imageId = built.Id;
    report.imageId = imageId; report.configSha256 = sha256(fs.readFileSync(path.join(ROOT, 'deploy/novart/storage/garage.toml')));
    mark('create');
    check(inspect('container', name, true) === null);
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'novart-garage-ci-'));
    fs.chmodSync(tempDirectory, 0o700);
    fs.writeFileSync(path.join(tempDirectory, 'runtime.env'), `GARAGE_RPC_SECRET=${rpc}\nGARAGE_ADMIN_TOKEN=${adminToken}\nRUST_LOG=garage=warn\nRUST_BACKTRACE=0\n`, { mode: 0o600, flag: 'wx' });
    for (const volume of volumeNames) {
      check(inspect('volume', volume, true) === null);
      docker(['volume', 'create', '--label', label, volume]);
    }
    start(); mark('ready'); await waitReady();
    const layout = await admin('GetClusterLayout'); check(layout.version === 1);
    report.checks.singleNodeHealthy = true;
    mark('admin-auth');
    check([401, 403].includes((await request('ListKeys', undefined, '')).status));
    check((await admin('ListKeys')).length === 0 && (await admin('ListBuckets')).length === 0);
    report.checks.emptyIsolatedStore = true; report.checks.adminAuthentication = true;
    mark('permissions');
    const bucketName = `novart-ci-assets-${suffix}`;
    const deniedBucketName = `novart-ci-denied-${suffix}`;
    const bucket = await admin('CreateBucket', { globalAlias: bucketName });
    await admin('CreateBucket', { globalAlias: deniedBucketName });
    const key = await admin('CreateKey', { name: `novart-ci-app-${suffix}`, deny: { createBucket: true }, neverExpires: true });
    check(typeof key.accessKeyId === 'string' && typeof key.secretAccessKey === 'string');
    check(key.permissions.createBucket === false && key.buckets.length === 0);
    await admin('AllowBucketKey', { bucketId: bucket.id, accessKeyId: key.accessKeyId, permissions: { read: true, write: true, owner: false } });
    await checkKey(key.accessKeyId, bucket.id);
    check([401, 403].includes((await request('ListKeys', undefined, key.secretAccessKey)).status));
    report.checks.onlyTargetBucketReadWrite = true; report.checks.noOwnerOrCreateBucket = true;
    const credentials = { accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey };
    connect(credentials);
    const body = crypto.randomBytes(1024);
    const expectedHash = sha256(body);
    const objectKey = 'acceptance/retained.bin';
    mark('s3-roundtrip');
    await send(new PutObjectCommand({ Bucket: bucketName, Key: objectKey, Body: body, ContentType: 'application/octet-stream' }));
    const first = await send(new GetObjectCommand({ Bucket: bucketName, Key: objectKey }));
    check(sha256(await first.Body.transformToByteArray()) === expectedHash);
    await send(new PutObjectCommand({ Bucket: bucketName, Key: 'acceptance/delete-me.bin', Body: body }));
    await send(new DeleteObjectCommand({ Bucket: bucketName, Key: 'acceptance/delete-me.bin' }));
    await expectStatus(new GetObjectCommand({ Bucket: bucketName, Key: 'acceptance/delete-me.bin' }), 404);
    report.checks.putGetSha256 = true; report.checks.deleteSingleObject = true;
    mark('s3-denials');
    await expectStatus(new PutObjectCommand({ Bucket: deniedBucketName, Key: 'must-not-exist.bin', Body: body }), 403);
    await expectStatus(new ListObjectsV2Command({ Bucket: deniedBucketName }), 403);
    await expectStatus(new CreateBucketCommand({ Bucket: `novart-ci-forbidden-${suffix}` }), 403);
    report.checks.otherBucketDenied = true; report.checks.createBucketDenied = true;
    mark('recreate');
    docker(['stop', '--time', '20', name]); docker(['container', 'rm', name]);
    start(); await waitReady();
    check((await admin('GetClusterLayout')).version === layout.version);
    await checkKey(key.accessKeyId, bucket.id); connect(credentials);
    mark('durability');
    const restored = await send(new GetObjectCommand({ Bucket: bucketName, Key: objectKey }));
    check(sha256(await restored.Body.transformToByteArray()) === expectedHash);
    await expectStatus(new GetObjectCommand({ Bucket: bucketName, Key: 'acceptance/delete-me.bin' }), 404);
    await expectStatus(new ListObjectsV2Command({ Bucket: deniedBucketName }), 403);
    await send(new DeleteObjectCommand({ Bucket: bucketName, Key: objectKey }));
    report.checks.recreatedFromSameVolumes = true; report.checks.objectAndPermissionDurable = true;
    report.payloadSha256 = expectedHash;
    report.ok = true;
  } catch (error) {
    report.errorType = ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error';
  } finally {
    clearTimeout(timer); process.removeListener('SIGTERM', emergencyExit); process.removeListener('SIGINT', emergencyExit);
    client?.destroy();
    const failedStage = stage;
    mark('cleanup'); report.checks.cleanup = cleanup();
    report.ok = report.ok && report.checks.cleanup;
    report.stage = report.ok ? 'complete' : (report.errorType ? failedStage : 'cleanup');
    writeReport();
    process.stdout.write(JSON.stringify(report) + '\n');
    if (!report.ok) process.exitCode = 1;
  }
}

if (require.main === module) {
  if (process.argv.includes('--static-check')) {
    try { process.stdout.write(JSON.stringify(staticCheck()) + '\n'); }
    catch { process.stdout.write(JSON.stringify({ ok: false, staticOnly: true }) + '\n'); process.exitCode = 1; }
  } else {
    run().catch(error => {
      report.errorType = ['Error', 'TypeError', 'SyntaxError'].includes(error?.name) ? error.name : 'Error';
      writeReport(); process.stdout.write(JSON.stringify(report) + '\n'); process.exitCode = 1;
    });
  }
}

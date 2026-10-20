import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const script = readFileSync('cds-release.sh', 'utf8');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
test('the standard project release entry is valid Bash and rejects missing/unknown actions', () => {
  assert.equal(spawnSync('bash', ['-n', 'cds-release.sh']).status, 0);
  for (const args of [[], ['skip-checks'], ['--force']]) assert.equal(spawnSync('bash', ['cds-release.sh', ...args]).status, 64);
});
test('the exact project script check succeeds with no production settings or Docker', () => {
  const result = spawnSync('bash', ['cds-release.sh', 'check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
test('deployment rejects wrong branch, wrong commit and wrong target before Docker', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'novart-release-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'docker'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const env = { ...process.env, PATH: root + path.delimiter + process.env.PATH, CDS_BRANCH_NAME: 'main', CDS_COMMIT_SHA: sha, CDS_RELEASE_ID: 'rel-test', CDS_TARGET_ID: 'brandai-novartlab-local-prod' };
  for (const override of [{ CDS_BRANCH_NAME: 'feature' }, { CDS_COMMIT_SHA: '0'.repeat(40) }, { CDS_TARGET_ID: 'other-project' }]) {
    const result = spawnSync('bash', ['cds-release.sh', 'deploy'], { env: { ...env, ...override }, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
  }
});
test('the deploy branch cannot omit check, migration/readiness or served-resource checks', () => {
  assert.match(script, /\n    check\n    docker compose/);
  assert.doesNotMatch(script, /SKIP|--no-check|local-prod-release/);
  const compose = readFileSync('deploy/novart/production/compose.yml', 'utf8');
  assert.match(compose, /migrate: \{condition: service_completed_successfully\}/);
  assert.match(compose, /release-check: \{condition: service_completed_successfully\}/);
});
test('deploy uses the reviewed Compose only after check and stops on a failed prerequisite', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'novart-release-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'docker-args');
  writeFileSync(path.join(root, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CLI_LOG"\nexit "${CLI_EXIT:-0}"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: root + path.delimiter + process.env.PATH, CLI_LOG: log, CDS_BRANCH_NAME: 'main', CDS_COMMIT_SHA: sha, CDS_RELEASE_ID: 'rel-test', CDS_TARGET_ID: 'brandai-novartlab-local-prod' };
  const ok = spawnSync('bash', ['cds-release.sh', 'deploy'], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  const commands = readFileSync(log, 'utf8').trim().split('\n').map(line => line.replace('compose -p brandai-prod -f deploy/novart/production/compose.yml ', ''));
  assert.deepEqual(commands.slice(0, 3), ['config --quiet', 'up -d --remove-orphans', 'logs --no-color release-check']);
  assert.equal(commands.length, 6);
  for (const [index, origin] of ['https://deepflare.cn', 'https://deepflare.com.cn', 'https://www.novartlab.com'].entries()) assert.equal(commands[index + 3], `exec -T -e NOVART_VERIFY_ORIGIN=${origin} -e CDS_RELEASE_ID=rel-test web node /release/verify.mjs served`);
  writeFileSync(log, '');
  const failed = spawnSync('bash', ['cds-release.sh', 'deploy'], { env: { ...env, CLI_EXIT: '17' }, encoding: 'utf8' });
  assert.equal(failed.status, 17);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
  assert.doesNotMatch(failed.stdout, /Project release completed/);
});
test('both PR CI and immutable image CI execute the same project script contract', () => {
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/novart-integration.yml']) {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /bash cds-release\.sh check/);
    assert.match(source, /node --test scripts\/test-project-release\.mjs/);
  }
  assert.match(readFileSync('.github/workflows/branch-image.yml', 'utf8'), /'cds-release\.sh'/);
  assert.doesNotMatch(readFileSync('.github/workflows/branch-image.yml', 'utf8'), /branches: \['\*\*'\]/);
  for (const file of ['.github/workflows/branch-image.yml', '.github/workflows/novart-integration.yml']) {
    assert.match(readFileSync(file, 'utf8'), /if: github\.ref == 'refs\/heads\/main'/);
  }
  assert.match(readFileSync('CLAUDE.md', 'utf8'), /策略为 `project-script`/);
  assert.doesNotMatch(readFileSync('CLAUDE.md', 'utf8'), /策略为 `generated-compose`/);
});

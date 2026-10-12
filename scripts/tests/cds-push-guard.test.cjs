'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SKIP_MARKERS, findSkipMarker, parseUpdates, checkUpdates } = require('../cds-pre-push.cjs');
const installer = path.resolve(__dirname, '../install-cds-push-guard.cjs');
const guard = path.resolve(__dirname, '../cds-pre-push.cjs');
const zero = '0'.repeat(40), sha = 'a'.repeat(40);

for (const marker of SKIP_MARKERS) {
  test(`blocks ${marker} in commit body without case sensitivity`, () => {
    assert.equal(findSkipMarker(`fix: product change\n\n${marker.toUpperCase()}`), marker);
  });
}
test('checks valid final trailers and permits ordinary prose', () => {
  assert.equal(findSkipMarker('fix: entry\n\nReviewed-by: Example\nSkip-Checks: TRUE'), 'skip-checks: true');
  assert.equal(findSkipMarker('fix: entry\n\nDiscuss skip-checks: true in documentation.'), null);
  assert.equal(findSkipMarker('fix: entry\n\nskip-checks: true\nReviewed-by: Example'), null);
  assert.equal(findSkipMarker('skip-checks: true'), null);
});
test('parses Git stdin, skips deletions/tags, and rejects malformed input', () => {
  const updates = parseUpdates(`refs/heads/dev ${sha} refs/heads/dev ${zero}\n(delete) ${zero} refs/heads/old ${sha}\nrefs/tags/v1 ${sha} refs/tags/v1 ${zero}\n`);
  let reads = 0;
  assert.equal(checkUpdates(updates, () => { reads++; return 'fix: entry'; }).length, 0);
  assert.equal(reads, 1);
  assert.throws(() => parseUpdates('refs/heads/dev malformed refs/heads/dev 0'));
  assert.throws(() => parseUpdates(`refs/heads/dev ${sha}`));
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-push-guard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'repo'), remote = path.join(directory, 'remote.git');
  fs.mkdirSync(repo);
  const run = (command, args, options = {}) => spawnSync(command, args, { cwd: repo, encoding: 'utf8', ...options });
  const git = (...args) => { const result = run('git', args); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Guard Test'); git('config', 'user.email', 'guard@example.invalid');
  git('init', '--bare', '-q', remote); git('remote', 'add', 'origin', remote);
  const commit = message => { fs.writeFileSync(path.join(repo, 'entry.txt'), message); git('add', 'entry.txt'); git('commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  const install = () => run(process.execPath, [installer]);
  const remoteSha = ref => git('ls-remote', 'origin', ref).split(/\s/)[0];
  return { repo, run, git, commit, install, remoteSha };
}

test('installed hook allows historical markers and blocks the actual pushed tip', t => {
  const f = fixture(t);
  f.commit('historical isolated change [skip cds]');
  assert.equal(f.install().status, 0);
  assert.equal(f.install().status, 0, 'installation is repeatable');
  const clean = f.commit('fix: normal product change');
  f.git('push', 'origin', 'main'); assert.equal(f.remoteSha('refs/heads/main'), clean);
  const bad = f.commit('fix: change\n\n[CDS SKIP]');
  let result = f.run('git', ['push', 'origin', 'main']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /CDS 推送检查/);
  assert.equal(f.remoteSha('refs/heads/main'), clean, 'blocked push leaves remote unchanged');
  assert.equal(f.git('rev-parse', 'HEAD'), bad, 'hook never rewrites local history');
  f.git('branch', 'safe', clean);
  f.git('push', 'origin', 'safe'); assert.equal(f.remoteSha('refs/heads/safe'), clean, 'checks the pushed ref rather than current HEAD');
  f.git('branch', 'safe-two', clean);
  result = f.run('git', ['push', 'origin', 'safe-two', 'main']);
  assert.notEqual(result.status, 0); assert.equal(f.remoteSha('refs/heads/safe-two'), '', 'one unsafe tip blocks a multi-ref push');
  f.git('push', 'origin', ':safe'); assert.equal(f.remoteSha('refs/heads/safe'), '', 'deletion is allowed');
  f.git('tag', '-a', 'historical-tag', '-m', '[skip cds] historical release', clean);
  f.git('push', 'origin', 'historical-tag'); assert.notEqual(f.remoteSha('refs/tags/historical-tag'), '');
  assert.notEqual(f.run(process.execPath, [guard, '--check-head']).status, 0);
});

test('installer preserves an existing unmanaged hook', t => {
  const f = fixture(t), hook = path.join(f.repo, '.git/hooks/pre-push');
  const original = '#!/bin/sh\necho existing-check\n'; fs.writeFileSync(hook, original);
  assert.notEqual(f.install().status, 0); assert.equal(fs.readFileSync(hook, 'utf8'), original);
});
test('installer preserves a custom hooks directory', t => {
  const f = fixture(t); f.git('config', 'core.hooksPath', '.custom-hooks');
  assert.notEqual(f.install().status, 0); assert.equal(f.git('config', '--get', 'core.hooksPath'), '.custom-hooks');
  assert.equal(fs.existsSync(path.join(f.repo, '.git/hooks/pre-push')), false);
});
test('installer preserves a dangling hook symlink', t => {
  const f = fixture(t), hook = path.join(f.repo, '.git/hooks/pre-push');
  fs.symlinkSync('missing-existing-hook', hook);
  assert.notEqual(f.install().status, 0); assert.equal(fs.readlinkSync(hook), 'missing-existing-hook');
});
test('installation from a subdirectory uses the repository hooks directory', t => {
  const f = fixture(t), nested = path.join(f.repo, 'nested'); fs.mkdirSync(nested);
  assert.equal(f.run(process.execPath, [installer], { cwd: nested }).status, 0);
  assert.equal(fs.readFileSync(path.join(f.repo, '.git/hooks/pre-push'), 'utf8'), fs.readFileSync(guard, 'utf8'));
});

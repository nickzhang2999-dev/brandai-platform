#!/usr/bin/env node
// BrandAI CDS push guard: managed by scripts/install-cds-push-guard.cjs.
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const SKIP_MARKERS = ['[skip cds]', '[cds skip]', '[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]'];

function findSkipMarker(message) {
  const normalized = message.toLowerCase();
  const marker = SKIP_MARKERS.find(value => normalized.includes(value));
  if (marker) return marker;
  // CDS also recognizes GitHub's final skip-checks trailer. Ordinary prose
  // containing the same words is not a trailer and must not block a push.
  const paragraphs = normalized.replace(/\r\n?/g, '\n').trimEnd().split(/\n\s*\n/);
  if (paragraphs.length < 2) return null;
  const lines = paragraphs.at(-1).split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length || !lines.every(line => /^[a-z0-9-]+:\s*\S.*$/.test(line))) return null;
  return /^skip-checks:\s*true$/.test(lines.at(-1)) ? 'skip-checks: true' : null;
}

function parseUpdates(input) {
  return input.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || ![fields[1], fields[3]]
      .every(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value))) {
      throw new Error('无法解析 Git 推送引用，已停止推送。');
    }
    return { localRef: fields[0], localSha: fields[1], remoteRef: fields[2], remoteSha: fields[3] };
  });
}

function checkUpdates(updates, readMessage) {
  const failures = [];
  for (const update of updates) {
    // Only the branch tip that this push publishes is checked. Ancestors,
    // branch deletions and tags do not select a CDS branch preview version.
    if (!update.remoteRef.startsWith('refs/heads/') || /^0+$/.test(update.localSha)) continue;
    const marker = findSkipMarker(readMessage(update.localSha));
    if (marker) failures.push({ ref: update.remoteRef, sha: update.localSha, marker });
  }
  return failures;
}

function main() {
  const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const updates = process.argv[2] === '--check-head'
    ? [{ localSha: git(['rev-parse', 'HEAD']), remoteRef: 'refs/heads/HEAD' }]
    : parseUpdates(fs.readFileSync(0, 'utf8'));
  const failures = checkUpdates(updates, sha => git(['show', '-s', '--format=%B', sha]));
  if (failures.length) {
    for (const failure of failures) {
      console.error(`[CDS 推送检查] 已拦截 ${failure.ref}@${failure.sha.slice(0, 12)}：提交信息包含 ${failure.marker}。`);
    }
    console.error('正常开发提交不得跳过 CDS。请移除本次新提交信息中的跳过标记；旧历史无需修改。');
    console.error('标题和正文都参与检查，文档中的历史引用不参与检查。不要使用 --no-verify 绕过门禁。');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try { main(); } catch {
    console.error('[CDS 推送检查] 无法完成提交检查，已停止推送；请检查 Git 引用和本地 Node/Git 环境。');
    process.exitCode = 1;
  }
}

module.exports = { SKIP_MARKERS, findSkipMarker, parseUpdates, checkUpdates };

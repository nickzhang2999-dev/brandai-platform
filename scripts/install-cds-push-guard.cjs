#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MANAGED_HEADER = '// BrandAI CDS push guard: managed by scripts/install-cds-push-guard.cjs.';

function install() {
  const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const root = git(['rev-parse', '--show-toplevel']);
  process.chdir(root);
  let configuredPath;
  try { configuredPath = git(['config', '--get', 'core.hooksPath']); }
  catch (error) { if (error.status !== 1) throw error; }
  if (configuredPath) throw new Error('已存在自定义 core.hooksPath，安装器保留原设置，请先整合现有推送钩子。');
  const directory = path.resolve(root, git(['rev-parse', '--git-path', 'hooks']));
  const hook = path.join(directory, 'pre-push');
  let existing;
  try { existing = fs.lstatSync(hook); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (existing.isSymbolicLink() || !fs.readFileSync(hook, 'utf8').includes(MANAGED_HEADER)) {
      throw new Error('已存在其他 pre-push 钩子，安装器保留原文件，请先整合现有检查。');
    }
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(hook, fs.readFileSync(path.join(__dirname, 'cds-pre-push.cjs')), { mode: 0o755 });
  fs.chmodSync(hook, 0o755);
  console.log('CDS 推送检查已安装到当前仓库；普通 git push 会自动检查本次发布的分支末端提交。');
}

if (require.main === module) {
  try { install(); } catch (error) {
    console.error(`[CDS 推送检查安装] ${error.message}`);
    process.exitCode = 1;
  }
}

#!/bin/sh
# scripts/cds-web-start.sh
#
# geole.me CDS web 服务启动包装。
#
# 根因（2026-06-23 抓容器 stdout 定位）：CDS 项目配置里 web 的 run command 是一条
# 同步链 `corepack enable && pnpm install && db:generate && db:push && db:seed &&
# build && next start`，**只在最后一步 next start 才开端口、无占位服务器**。冷构建
# （pnpm install + db:push/seed + next build ~200s+）远超 CDS ~248s 就绪探测窗 →
# "端口未响应" → 容器被回收 → .next 的 build 标记永不落盘 → 每次都冷构建 → 死锁。
# （注：仓库 cds-compose.yml 指向的 scripts/web-startup.sh 在 geole.me CDS 上不被
# 调用——该 CDS 跑的是项目配置里的 command，不读 compose 的 command。）
#
# 修复：本脚本先用 Node 占位服务器秒开端口（探测立刻通过），再前台跑**与原链完全
# 一致**的 prep（db:push/db:seed 原样，不改任何 DB 行为）+ next build，最后杀占位、
# exec 进 next start 复用同端口。即冷构建不必压进就绪窗，只要端口能持续应答。
#
# 不变式（对齐 CLAUDE.md §0.4）：(a) <2s 开端口；(b) HEAD/代码变化必经 next build
# 重新构建（本脚本每次都 build，绝不跳过 → 永不服务旧代码）。
set -e

PORT="${PORT:-3000}"
corepack enable

# 占位服务器：所有路径返回 200，浏览器给「正在部署」自刷新页，探测/接口给 JSON。
PLACEHOLDER_JS="
const http = require('http');
const port = parseInt(process.env.PORT || '3000', 10);
const startedAt = Date.now();
http.createServer((req, res) => {
  const secs = Math.round((Date.now() - startedAt) / 1000);
  const accept = req.headers['accept'] || '';
  if (accept.indexOf('text/html') !== -1) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '5' });
    res.end('<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">' +
      '<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">' +
      '<meta http-equiv=\"refresh\" content=\"5\"><title>正在部署 · BrandAI</title>' +
      '<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;' +
      'font-family:system-ui,sans-serif;background:#FAFAFC;color:#1e1e3c}.box{text-align:center;padding:2rem}' +
      '.spin{width:2.5rem;height:2.5rem;margin:0 auto 1.5rem;border:3px solid #ECECF3;border-top-color:#7C5CFF;' +
      'border-radius:50%;animation:s .9s linear infinite}@keyframes s{to{transform:rotate(360deg)}}' +
      'h1{font-size:1.15rem;margin:0 0 .5rem}p{font-size:.85rem;color:#6a6a73;margin:.25rem 0}</style></head>' +
      '<body><div class=\"box\"><div class=\"spin\"></div><h1>正在部署中…</h1>' +
      '<p>新版本正在构建并启动，页面将自动刷新。</p>' +
      '<p style=\"color:#9a9aa3\">已等待 ' + secs + ' 秒</p></div></body></html>');
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '5' });
  res.end(JSON.stringify({ status: 'building', web: 'building', elapsedMs: Date.now() - startedAt }));
}).listen(port, '0.0.0.0', () => console.log('[ph] placeholder listening on :' + port));
process.on('SIGTERM', () => process.exit(0));
"

node -e "$PLACEHOLDER_JS" &
PLACEHOLDER_PID=$!
echo "[cds-web] placeholder pid=$PLACEHOLDER_PID"
# 占位进程提到最高调度优先级，确保冷构建占满 CPU 时仍能答就绪探测。
renice -n -19 -p "$PLACEHOLDER_PID" >/dev/null 2>&1 || true
sleep 1

# 与原 CDS 命令完全一致的 prep（不改 DB 行为）+ build。nice 让位给占位进程。
nice -n 19 pnpm install --frozen-lockfile --prefer-offline
nice -n 19 pnpm db:generate
nice -n 19 pnpm db:push
nice -n 19 pnpm db:seed
nice -n 19 pnpm --filter @brandai/web build

# 构建完成：杀占位，释放端口，exec 进真正的 next start（复用 :PORT）。
echo "[cds-web] build done; swapping placeholder → next start"
kill "$PLACEHOLDER_PID" 2>/dev/null || true
sleep 2
exec pnpm --filter @brandai/web exec next start -H 0.0.0.0 -p "$PORT"

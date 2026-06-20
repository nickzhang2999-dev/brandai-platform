#!/bin/sh
# scripts/worker-startup.sh
#
# Worker startup orchestration.
#
# CRITICAL INVARIANT (learned 2026-05-29): the web and worker containers
# BOTH bind-mount the repo at `.:/app`, so they share ONE physical
# `/app/node_modules`. If both run `pnpm install` concurrently they corrupt
# each other — the worker's install hit
#   ENOENT .../next/node_modules/next/package.json
#   ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "prisma" not found
# because web was rm-ing / rewriting the same node_modules mid-install. The
# worker's own `rm -rf node_modules` (the poisoned-store retry) was the most
# destructive part — it deleted node_modules out from under a running web.
#
# Fix: the worker is a PURE CONSUMER of web's install. It does NOT install,
# does NOT prisma-generate, does NOT touch node_modules. web-startup.sh is
# the single writer of the shared node_modules + .prisma client. The worker
# binds a placeholder for the readiness probe, WAITS until web has made the
# shared tree usable (tsx resolves), then exec's the BullMQ workers.
set -e

PORT=${WORKER_HEALTH_PORT:-3001}

corepack enable

# Placeholder so the CDS readiness probe passes while we wait for web's
# install. Reports "starting" + how long we've waited.
PLACEHOLDER_JS="
const http = require('http');
const port = parseInt(process.env.WORKER_HEALTH_PORT || '3001', 10);
const startedAt = Date.now();
http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-placeholder': '1' });
  res.end(JSON.stringify({ worker: 'starting', waitingForWebInstall: true, elapsedMs: Date.now() - startedAt, pid: process.pid }));
}).listen(port, '0.0.0.0', () => {
  console.log('[worker-placeholder] listening on :' + port + ' pid=' + process.pid);
});
process.on('SIGTERM', () => process.exit(0));
"
node -e "$PLACEHOLDER_JS" &
PLACEHOLDER_PID=$!
echo "[worker-startup] placeholder pid=$PLACEHOLDER_PID"
sleep 1

# Wait for web to finish preparing the shared tree. The probe imports
# @brandai/db through tsx, which only succeeds when ALL three things the
# workers need are in place: tsx resolves, node_modules is intact, and the
# Prisma client has been generated (importing the db package instantiates
# PrismaClient, which throws "did not initialize yet" until `prisma generate`
# has run). web-startup.sh is the single writer of all three; once its
# install + generate (and any poisoned-store recovery) settle, this succeeds
# and stays stable. Up to ~8 min; the placeholder keeps answering 200 so the
# worker has no readiness cliff of its own.
WAIT_LOG="/tmp/worker-startup-wait.log"
: > "$WAIT_LOG"
echo "[worker-startup] waiting for web's shared node_modules + prisma client…"
READY=0
i=0
while [ "$i" -lt 160 ]; do
  if pnpm --filter @brandai/web exec tsx --eval \
    "import('@brandai/db').then(m => { void m.prisma; process.exit(0); }).catch(e => { console.error(String(e)); process.exit(1); })" \
    >> "$WAIT_LOG" 2>&1; then
    READY=1
    echo "[worker-startup] shared tree ready (tsx + prisma client) after ~$((i * 3))s"
    break
  fi
  i=$((i + 1))
  sleep 3
done

if [ "$READY" -ne 1 ]; then
  echo "[worker-startup] tsx never resolved (web install didn't complete in ~8m); 503 forensics"
  kill "$PLACEHOLDER_PID" 2>/dev/null || true
  sleep 2
  exec node -e "
    const http = require('http');
    const fs = require('fs');
    const port = parseInt(process.env.WORKER_HEALTH_PORT || '3001', 10);
    http.createServer((_req, res) => {
      let log = '';
      try { log = fs.readFileSync('/tmp/worker-startup-wait.log', 'utf8'); } catch {}
      res.writeHead(503, { 'content-type': 'application/json', 'x-placeholder': 'wait-timeout' });
      res.end(JSON.stringify({ status: 'wait-timeout', detail: 'web shared node_modules never became usable (tsx unresolved after ~8m)', waitLogTail: log.split('\\n').slice(-50).join('\\n') }));
    }).listen(port, '0.0.0.0', () => console.log('[worker-forensics] 503 wait-timeout on :' + port));
  "
fi

# Hand off: tear down the placeholder and exec the workers. index.ts binds
# the health port first and self-reports any boot error (it never exits on
# a constructor/connection failure), so a problem here surfaces via
# /api/health rather than an opaque exitCode=1.
echo "[worker-startup] prep done; tearing down placeholder, exec tsx workers"
kill "$PLACEHOLDER_PID" 2>/dev/null || true
sleep 2
exec pnpm --filter @brandai/web exec tsx src/lib/workers/index.ts

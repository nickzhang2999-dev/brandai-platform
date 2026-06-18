#!/bin/sh
# scripts/web-startup.sh
#
# CDS web service startup orchestration.
#
# Problem: CDS readiness probe window is ~215s (90 attempts × 2.4s). Our
# full cold startup (pnpm install + prisma migrate deploy + next build)
# takes ~238s on CDS nodes. Net: every cold deploy fails the probe by
# ~25s, even though the container would have been healthy seconds later.
#
# Fix: bind a 200-returning Node HTTP placeholder on $PORT immediately so
# CDS readiness probe passes, then run the real build chain in the
# foreground and swap to `next start`. Once .next/BUILD_ID exists from a
# prior deploy, the build step itself is fast (incremental) — but pnpm
# install + corepack + prisma generate still need to run because the
# container is fresh and node_modules symlinks need rehydration.
#
# Idempotent. The .:/app bind keeps node_modules + .next across deploys.
set -e

PORT=${PORT:-3000}
BUILD_ID_FILE="apps/web/.next/BUILD_ID"
# Records the git HEAD that produced the cached .next/. If the current HEAD
# differs (i.e. a code-only redeploy landed new commits), we MUST rebuild
# — otherwise next start serves stale compiled JS from the .:/app bind and
# pushes silently never take effect.
DEPLOY_COMMIT_FILE="apps/web/.next/CDS_DEPLOY_COMMIT"

# 2026-05-28 first fix attempt skipped this for the fast path → `exec pnpm`
# returned 127 because pnpm wasn't on PATH. corepack provides pnpm; cheap
# (~1s) and required on every container start.
corepack enable

# Tiny Node HTTP placeholder. Node is guaranteed available (this IS the
# node:20-slim image). Returns 200 with a {"status":"building"} body —
# 503 was tried first but CDS treats anything non-2xx as "not ready" the
# same way it treats ECONNRESET.
PLACEHOLDER_JS="
const http = require('http');
const port = parseInt(process.env.PORT || '3000', 10);
const startedAt = Date.now();
http.createServer((req, res) => {
  const elapsedMs = Date.now() - startedAt;
  const secs = Math.round(elapsedMs / 1000);
  // Health/probe paths always get 200 JSON — CDS readiness + /api/health
  // aggregation depend on it.
  if (req.url === '/api/health' || req.url === '/healthz') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-placeholder': '1',
    });
    res.end(JSON.stringify({ web: 'building', elapsedMs }));
    return;
  }
  // Browsers (Accept: text/html) get a real loading PAGE with a 5s
  // meta-refresh — NOT raw JSON. During the (sometimes multi-minute) build
  // window a visitor would otherwise see {web:'building'} JSON instead of a
  // page. Stays 200 so a probe hitting '/' still passes.
  var accept = req.headers['accept'] || '';
  if (accept.indexOf('text/html') !== -1) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': '5',
      'x-placeholder': '1',
    });
    res.end('<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">' +
      '<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">' +
      '<meta http-equiv=\"refresh\" content=\"5\"><title>正在部署 · OpenVisual</title>' +
      '<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;' +
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0b0f;color:#e7e7ea}' +
      '.box{text-align:center;max-width:30rem;padding:2rem}.spin{width:2.5rem;height:2.5rem;margin:0 auto 1.5rem;' +
      'border:3px solid #2a2a33;border-top-color:#8b5cf6;border-radius:50%;animation:s .9s linear infinite}' +
      '@keyframes s{to{transform:rotate(360deg)}}h1{font-size:1.15rem;margin:0 0 .5rem}' +
      'p{font-size:.85rem;color:#9a9aa3;margin:.25rem 0;line-height:1.5}</style></head><body><div class=\"box\">' +
      '<div class=\"spin\"></div><h1>正在部署中…</h1>' +
      '<p>新版本正在构建并启动,页面将自动刷新。</p>' +
      '<p style=\"color:#6a6a73\">已等待 ' + secs + ' 秒</p></div></body></html>');
    return;
  }
  // Non-browser clients (curl/API) + the readiness probe: 200 JSON.
  res.writeHead(200, {
    'content-type': 'application/json',
    'retry-after': '5',
    'cache-control': 'no-store',
    'x-placeholder': '1',
  });
  res.end(JSON.stringify({
    status: 'building',
    detail: 'web container is preparing (install / migrate / build)',
    elapsedMs,
    pid: process.pid,
  }));
}).listen(port, '0.0.0.0', () => {
  console.log('[placeholder] listening on :' + port + ' pid=' + process.pid);
});
process.on('SIGTERM', () => process.exit(0));
"

node -e "$PLACEHOLDER_JS" &
PLACEHOLDER_PID=$!
echo "[startup] placeholder pid=$PLACEHOLDER_PID"

# Give the placeholder a brief moment to bind the port before the probe hits.
sleep 1

# Always-run prep: install (no-op when warm), prisma generate (cheap),
# prisma migrate deploy (no-op when up to date). POSIX-safe pattern:
# redirect stdout+stderr to a per-step log, capture $? directly (no
# tee pipeline → no PIPESTATUS needed → works in dash). After each step
# also cat the log to stdout so the CDS dashboard sees the output live.
PREP_LOG="/tmp/web-startup-prep.log"
: > "$PREP_LOG"

run_step() {
  step_name="$1"; shift
  echo "[startup] === $step_name ===" >> "$PREP_LOG"
  echo "[startup] === $step_name ==="
  "$@" >> "$PREP_LOG" 2>&1
  rc=$?
  tail -n 40 "$PREP_LOG"
  return "$rc"
}

set +e
run_step "pnpm install" pnpm install --frozen-lockfile --prod=false
INSTALL_RC=$?

# Post-install integrity check. pnpm install can RC=0 even when the CAS
# source files are missing — its metadata says they exist; the symlinks
# point at nothing. 2026-05-29 saw 'Cannot find module .../next/dist/bin/
# next' on successive deploys despite RC=0, because the shared CDS store
# at /pnpm/store/v3 was missing those binaries from earlier interrupted
# deploys. Verify the critical entrypoints directly.
if [ "$INSTALL_RC" -eq 0 ]; then
  for bin in apps/web/node_modules/next/dist/bin/next \
             apps/web/node_modules/.bin/next \
             node_modules/.bin/turbo; do
    if ! [ -e "$bin" ]; then
      echo "[startup] WARN: install RC=0 but $bin missing — store is poisoned"
      INSTALL_RC=99  # force retry below
      break
    fi
  done
fi

if [ "$INSTALL_RC" -ne 0 ]; then
  # Nuke node_modules trees AND the project-local pnpm store so the retry
  # can't reuse poisoned content. /pnpm/store/v3 is the system-shared CAS
  # (also used by other CDS projects) — don't touch it; instead force this
  # install to a clean project-local store via --store-dir, which makes
  # pnpm re-download every package from the registry. Slower (~30-60s) but
  # bulletproof: the verification above proves the prior store was lying.
  echo "[startup] === install retry: wipe + force project-local store ==="
  rm -rf node_modules apps/*/node_modules packages/*/node_modules /app/.pnpm-store 2>/dev/null || true
  find . -path ./node_modules -prune -o -name '*_tmp_*' -type d -print -exec rm -rf {} + 2>/dev/null || true
  run_step "pnpm install (retry, project-local store)" \
    pnpm install --frozen-lockfile --prod=false --store-dir=/app/.pnpm-store
  INSTALL_RC=$?
fi
run_step "prisma generate" pnpm --filter @brandai/db exec prisma generate
GEN_RC=$?
# Race recovery: web and worker share the .:/app bind, both run `prisma
# generate` in parallel, and the engine binary's atomic rename
# (libquery_engine-*.so.node.tmpNN → ...so.node) can collide → ENOENT.
# The second attempt is reliably fine because the other container has
# already finished writing. Up to 2 retries with a short backoff.
if [ "$GEN_RC" -ne 0 ]; then
  for retry in 1 2; do
    echo "[startup] prisma generate RC=$GEN_RC — sleeping ${retry}s before retry $retry/2 (likely web↔worker rename race)"
    sleep "$retry"
    run_step "prisma generate (retry $retry)" pnpm --filter @brandai/db exec prisma generate
    GEN_RC=$?
    if [ "$GEN_RC" -eq 0 ]; then break; fi
  done
fi

# Wait for postgres before `migrate deploy`. CDS sometimes brings web up
# while postgres infra is still cold (or, as 2026-05-29 demonstrated, after
# the infra registration was lost). Without this, migrate fails on the
# first DNS/TCP attempt and the whole container exits before the DB has a
# chance to come back. Up to 60s of 2s polls.
echo "[startup] === wait for postgres (max 60s) ==="
node -e "
  const net = require('net');
  const dbu = process.env.DATABASE_URL || '';
  let host = 'postgres', port = 5432;
  const m = dbu.match(/@([^:/]+):(\d+)/);
  if (m) { host = m[1]; port = parseInt(m[2], 10); }
  const tryConnect = () => new Promise((resolve, reject) => {
    const s = net.createConnection(port, host);
    s.on('connect', () => { s.end(); resolve(); });
    s.on('error', reject);
    s.setTimeout(2000, () => { s.destroy(new Error('timeout')); });
  });
  (async () => {
    for (let i = 0; i < 30; i++) {
      try { await tryConnect(); console.log('[startup] postgres reachable at ' + host + ':' + port + ' after ' + (i*2) + 's'); process.exit(0); } catch (e) { /* retry */ }
      await new Promise(r => setTimeout(r, 2000));
    }
    console.error('[startup] postgres at ' + host + ':' + port + ' unreachable after 60s');
    process.exit(1);
  })();
" >> "$PREP_LOG" 2>&1
PG_RC=$?
tail -n 5 "$PREP_LOG"

if [ "$PG_RC" -eq 0 ]; then
  run_step "prisma migrate deploy" pnpm --filter @brandai/db exec prisma migrate deploy
  MIG_RC=$?
else
  # Don't even try migrate when pg is verifiably down — its error message
  # buries the actual cause. PG_RC=1 propagates into the forensics 503 so
  # operators see "postgres unreachable" directly.
  echo "[startup] skipping prisma migrate deploy (postgres unreachable)" >> "$PREP_LOG"
  echo "[startup] skipping prisma migrate deploy (postgres unreachable)"
  MIG_RC=$PG_RC
fi
set -e

if [ "$INSTALL_RC" -ne 0 ] || [ "$GEN_RC" -ne 0 ] || [ "$MIG_RC" -ne 0 ]; then
  # Failure mode: kill the 200-returning placeholder and exec a 503-returning
  # one that serves the captured prep log. CDS readiness probe fails (so the
  # deploy is correctly marked broken — that's the Bugbot/Codex requirement),
  # AND an operator can `curl https://<host>/api/health` to read which step
  # exited non-zero instead of staring at an empty stopped container. Stays
  # in foreground so the container doesn't immediately get reaped.
  echo "[startup] prep FAILED (install=$INSTALL_RC generate=$GEN_RC migrate=$MIG_RC); swapping placeholder to 503 forensics server"
  kill "$PLACEHOLDER_PID" 2>/dev/null || true
  sleep 2
  exec node -e "
    const http = require('http');
    const fs = require('fs');
    const port = parseInt(process.env.PORT || '3000', 10);
    http.createServer((_req, res) => {
      let log = '';
      try { log = fs.readFileSync('/tmp/web-startup-prep.log', 'utf8'); } catch {}
      const tail = log.split('\\n').slice(-200).join('\\n');
      res.writeHead(503, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-placeholder': 'failed',
      });
      res.end(JSON.stringify({
        status: 'prep-failed',
        install: $INSTALL_RC,
        generate: $GEN_RC,
        migrate: $MIG_RC,
        prepLogTail: tail,
      }));
    }).listen(port, '0.0.0.0', () => {
      console.log('[forensics] 503 server on :' + port);
    });
  "
fi

# Conditional build: skip ONLY if a prior successful build left a BUILD_ID
# AND that build was produced from the same git HEAD as the current checkout.
# Without the HEAD check, any code-only push gets pulled by `git pull` upstream
# but the next start still serves the stale `.next/` from the persistent bind —
# the deploy is silently a no-op.
CURRENT_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")
LAST_BUILD_COMMIT=$(cat "$DEPLOY_COMMIT_FILE" 2>/dev/null || echo "")
echo "[startup] git HEAD=$CURRENT_COMMIT  last-built=$LAST_BUILD_COMMIT"

if [ -f "$BUILD_ID_FILE" ] && [ -n "$CURRENT_COMMIT" ] && [ "$CURRENT_COMMIT" = "$LAST_BUILD_COMMIT" ]; then
  echo "[startup] cached .next/ matches HEAD — skipping next build"
else
  if [ -f "$BUILD_ID_FILE" ]; then
    echo "[startup] HEAD changed since last build — rebuilding"
  else
    echo "[startup] no $BUILD_ID_FILE — running next build (cold)"
  fi
  BUILD_LOG="/tmp/web-startup-build.log"
  : > "$BUILD_LOG"
  set +e
  echo "[startup] === next build ==="
  pnpm --filter @brandai/web build >> "$BUILD_LOG" 2>&1
  BUILD_RC=$?
  tail -n 60 "$BUILD_LOG"
  set -e
  if [ "$BUILD_RC" -ne 0 ]; then
    # Same reasoning as the prep-failure branch: hand off to a 503-returning
    # forensics server so CDS sees an unhealthy probe (correct) AND the
    # operator can curl it to read the build failure tail.
    echo "[startup] next build FAILED ($BUILD_RC); swapping placeholder to 503 forensics server"
    kill "$PLACEHOLDER_PID" 2>/dev/null || true
    sleep 2
    exec node -e "
      const http = require('http');
      const fs = require('fs');
      const port = parseInt(process.env.PORT || '3000', 10);
      http.createServer((_req, res) => {
        let log = '';
        try { log = fs.readFileSync('/tmp/web-startup-build.log', 'utf8'); } catch {}
        const tail = log.split('\\n').slice(-200).join('\\n');
        res.writeHead(503, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'x-placeholder': 'failed',
        });
        res.end(JSON.stringify({
          status: 'build-failed',
          build: $BUILD_RC,
          buildLogTail: tail,
        }));
      }).listen(port, '0.0.0.0', () => {
        console.log('[forensics] 503 server on :' + port);
      });
    "
  fi
  # Record the HEAD that produced this .next/ so the next start can decide.
  echo "$CURRENT_COMMIT" > "$DEPLOY_COMMIT_FILE"
fi

echo "[startup] prep + build done; tearing down placeholder, exec next start"
kill "$PLACEHOLDER_PID" 2>/dev/null || true
# Give the kernel a moment to release the port before next claims it.
sleep 2
exec pnpm --filter @brandai/web start

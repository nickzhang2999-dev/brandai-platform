#!/bin/sh
# scripts/web-build.sh — wrapper around `next build` for the apps/web `build` script.
#
# On geole.me CDS the web run-command is a synchronous chain that only opens the
# port at the final `next start`, so a cold `next build` overruns CDS's ~248s
# readiness probe and the container is reaped before serving (deadlock — see
# scripts/build-placeholder.cjs). When CDS_BUILD_PLACEHOLDER is set we bind a
# placeholder on $PORT for the duration of the build so the probe passes
# mid-chain, then release it for the chain's subsequent `next start`.
#
# Local + CI builds (no CDS_BUILD_PLACEHOLDER) run `next build` verbatim — this
# wrapper is a no-op there, so `pnpm -F web build` / turbo are unchanged.
#
# cwd is apps/web (pnpm runs package scripts in the package dir); `next` is on
# PATH via pnpm's injected node_modules/.bin.

if [ -z "$CDS_BUILD_PLACEHOLDER" ]; then
  exec next build
fi

PORT="${PORT:-3000}"
SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"
node "$SCRIPT_DIR/build-placeholder.cjs" &
PH=$!
# Pin the placeholder to top scheduler priority so the CPU-bound build can't
# starve it out of answering probes. Best-effort (needs privilege).
renice -n -19 -p "$PH" >/dev/null 2>&1 || true
echo "[web-build] placeholder pid=$PH on :$PORT — running next build (niced)…"

# nice the build down so the placeholder always wins CPU for probe responses.
# No `set -e`: we must capture the rc, kill the placeholder, and propagate it —
# so a build failure can't leave the placeholder masking the port as "ready".
nice -n 19 next build
BUILD_RC=$?

echo "[web-build] next build rc=$BUILD_RC — releasing placeholder for next start"
kill "$PH" 2>/dev/null || true
# Give the kernel a moment to free the port before the chain's `next start` binds.
sleep 2
exit "$BUILD_RC"

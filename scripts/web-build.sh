#!/bin/sh
# scripts/web-build.sh — wrapper around `next build` for the apps/web `build` script.
#
# On geole.me CDS the web run-command is a synchronous chain that only opens the
# port at the final `next start`, so a cold `next build` overruns CDS's ~248s
# readiness probe and the container is reaped before serving (deadlock — see
# scripts/build-placeholder.cjs). The placeholder is started at `preinstall`
# (scripts/cds-preinstall.cjs — earliest hook, binds within seconds) so the
# probe passes long before the build finishes. THIS wrapper's job at build time:
# ensure the placeholder is up (fallback if preinstall didn't run), then after
# `next build` KILL it so the chain's subsequent `next start` can reclaim $PORT.
#
# Local + CI builds (no CDS_BUILD_PLACEHOLDER) run `next build` verbatim — no-op.
#
# cwd is apps/web (pnpm runs package scripts in the package dir); `next` is on
# PATH via pnpm's injected node_modules/.bin.

if [ -z "$CDS_BUILD_PLACEHOLDER" ]; then
  exec next build
fi

PORT="${PORT:-3000}"
SCRIPT_DIR="$(CDPATH= cd "$(dirname "$0")" && pwd)"

# Fallback: if preinstall's placeholder isn't running for any reason, start one
# now (better late than never; preinstall is the primary, early bind).
if ! pgrep -f build-placeholder.cjs >/dev/null 2>&1; then
  node "$SCRIPT_DIR/build-placeholder.cjs" &
  renice -n -19 -p "$!" >/dev/null 2>&1 || true
  echo "[web-build] placeholder not found — started fallback on :$PORT"
fi

echo "[web-build] running next build (niced)…"
# nice the build down so the placeholder always wins CPU for probe responses.
# No `set -e`: capture rc, kill placeholder, propagate — so a build failure can't
# leave the placeholder masking the port as "ready".
nice -n 19 next build
BUILD_RC=$?

echo "[web-build] next build rc=$BUILD_RC — killing placeholder, releasing port"
pkill -f build-placeholder.cjs 2>/dev/null || true
# Give the kernel a moment to free the port before the chain's `next start` binds.
sleep 2
exit "$BUILD_RC"

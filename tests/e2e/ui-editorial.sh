#!/usr/bin/env bash
# P1.0 · Editorial light-theme smoke test.
#
# Fetches public-facing pages (/, /login) and grep-asserts that:
#   - the html does NOT carry the dark theme class (`<html ... class="dark"`)
#   - light editorial CSS variables and/or token-driven utility classes appear
#
# If the local stack is unreachable, the test SKIPs (exit 0) — matching the
# behaviour of p0-flow.sh's health-check tripwires.
set -uo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
FAILED=0

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }

if ! curl -s -m 3 -o /dev/null "$BASE/api/health"; then
  echo "SKIP  ui-editorial: web not reachable at $BASE"
  exit 0
fi

for path in "/" "/login"; do
  HTML=$(curl -s -m 5 "$BASE$path" || true)
  if [ -z "$HTML" ]; then
    fail "fetch $path"
    continue
  fi

  # 1) html tag should NOT have class="dark"
  if printf '%s' "$HTML" | grep -E '<html[^>]*class="[^"]*\bdark\b' >/dev/null; then
    fail "$path html should not carry class=\"dark\" in editorial-light"
  else
    pass "$path html is not forced dark"
  fi

  # 2) Token-driven utility classes (bg-background, text-foreground, …) or the
  # editorial-light raw palette names should be present somewhere in the
  # rendered shell. We accept any of them.
  if printf '%s' "$HTML" | grep -E -e 'bg-background' -e 'text-foreground' \
      -e 'off-white' -e 'warm-sand' -e 'bg-card' >/dev/null; then
    pass "$path uses editorial-light tokens"
  else
    fail "$path missing editorial-light tokens"
  fi

  # 3) Hard-coded dark surface classes should not bleed into top-level shell.
  if printf '%s' "$HTML" | grep -E 'class="[^"]*\bbg-ink\b' >/dev/null; then
    fail "$path leaks dark-palette bg-ink in shell"
  else
    pass "$path no bg-ink leak"
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "ui-editorial: FAILED"
  exit 1
fi
echo "ui-editorial: OK"

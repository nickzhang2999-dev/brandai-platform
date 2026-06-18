#!/usr/bin/env bash
# M-B e2e — OAuth provider gating (D2/D7). GitHub/Google are offered only when
# their secrets are present, so an un-provisioned deploy exposes no broken
# buttons. Asserts the live /api/auth/providers map matches the env state.
set -uo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
FAILED=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }

P=$(curl -s "$BASE/api/auth/providers")
has() { echo "$P" | jq -e --arg id "$1" 'has($id)' >/dev/null 2>&1; }

# Password provider is always available.
has password && pass "password provider available" || fail "password provider missing"

# GitHub/Google only when secrets are set in the environment.
if [ -n "${AUTH_GITHUB_ID:-}" ] && [ -n "${AUTH_GITHUB_SECRET:-}" ]; then
  has github && pass "github offered (secrets present)" || fail "github missing despite secrets"
else
  has github && fail "github offered without secrets" || pass "github correctly hidden (no secrets)"
fi
if [ -n "${AUTH_GOOGLE_ID:-}" ] && [ -n "${AUTH_GOOGLE_SECRET:-}" ]; then
  has google && pass "google offered (secrets present)" || fail "google missing despite secrets"
else
  has google && fail "google offered without secrets" || pass "google correctly hidden (no secrets)"
fi

if [ "$FAILED" -eq 0 ]; then echo "AUTH OAUTH GATING: PASS"; exit 0; else echo "AUTH OAUTH GATING: FAIL"; exit 1; fi

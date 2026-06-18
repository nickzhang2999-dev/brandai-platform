#!/usr/bin/env bash
# Admin AI settings gate. The platform key is admin-only. Admin = the first
# registered user (bootstrap), or the ADMIN_EMAILS allowlist when set. This
# guard proves the gate rejects the unauthenticated and a non-admin user.
# Robust to the bootstrap: we register TWO users and assert the SECOND (which
# can never be the first registrant, so never the bootstrap admin) is blocked.
set -uo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
EP="$BASE/api/admin/settings/ai"
PW="correct-horse-battery"
J="$(mktemp)"; FAILED=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
assert() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2' want '$3')"; fi; }

reg() { curl -s -o /dev/null -X POST "$BASE/api/auth/register" \
  -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"$PW\"}"; }
login() { # <email> <password> <jar>
  local csrf; csrf=$(curl -s -c "$3" "$BASE/api/auth/csrf" | jq -r .csrfToken)
  curl -s -b "$3" -c "$3" -L -X POST "$BASE/api/auth/callback/password" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode "csrfToken=$csrf" --data-urlencode "email=$1" \
    --data-urlencode "password=$2" --data-urlencode "callbackUrl=$BASE/workspaces" >/dev/null
  curl -s -b "$3" "$BASE/api/auth/session" | jq -r '.user.id // empty'
}

# 1. unauthenticated → 401
U=$(curl -s -o /dev/null -w '%{http_code}' "$EP")
assert "unauthenticated GET 401" "$U" "401"

# 2. register two users; the second is never the bootstrap admin
reg "admin-a-$$-$RANDOM@brandai.dev"
B="admin-b-$$-$RANDOM@brandai.dev"
reg "$B"
SID=$(login "$B" "$PW" "$J")
[ -n "$SID" ] && pass "non-admin session" || fail "non-admin no session"

# 3. non-admin → 403 (GET and PUT)
G=$(curl -s -b "$J" -o /dev/null -w '%{http_code}' "$EP")
assert "non-admin GET 403" "$G" "403"
P=$(curl -s -b "$J" -o /dev/null -w '%{http_code}' -X PUT "$EP" \
  -H 'content-type: application/json' -d '{"image":{"provider":"openai"}}')
assert "non-admin PUT 403" "$P" "403"

# 4. (optional) admin path — when ADMIN_EMAIL/ADMIN_PASSWORD point at an admin
if [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  AJ="$(mktemp)"
  AID=$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD" "$AJ")
  [ -n "$AID" ] && pass "admin session" || fail "admin login failed"
  AG=$(curl -s -b "$AJ" -o /dev/null -w '%{http_code}' "$EP")
  assert "admin GET 200" "$AG" "200"
  rm -f "$AJ"
fi

rm -f "$J"
if [ "$FAILED" -eq 0 ]; then echo "ADMIN SETTINGS: PASS"; exit 0; else echo "ADMIN SETTINGS: FAIL"; exit 1; fi

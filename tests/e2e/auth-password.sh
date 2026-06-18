#!/usr/bin/env bash
# M-B e2e — real email/password auth (D2). Register → sign in via the
# "password" provider → session established. Wrong password is rejected,
# duplicate registration 409s, and a changed password takes effect.
set -uo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
EMAIL="pw-$$-$RANDOM@brandai.dev"
PW="correct-horse-battery"
J="$(mktemp)"; FAILED=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
assert() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2' want '$3')"; fi; }

# password login via the "password" credentials provider.
login() { # <email> <password> <jar>
  local csrf; csrf=$(curl -s -c "$3" "$BASE/api/auth/csrf" | jq -r .csrfToken)
  curl -s -b "$3" -c "$3" -L -X POST "$BASE/api/auth/callback/password" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode "csrfToken=$csrf" \
    --data-urlencode "email=$1" \
    --data-urlencode "password=$2" \
    --data-urlencode "callbackUrl=$BASE/workspaces" >/dev/null
  curl -s -b "$3" "$BASE/api/auth/session" | jq -r '.user.id // empty'
}

# 1. register
R=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/register" \
  -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
assert "register 201" "$R" "201"

# 2. duplicate register → 409
R2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/register" \
  -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
assert "duplicate register 409" "$R2" "409"

# 3. wrong password → no session
WID=$(login "$EMAIL" "wrong-password" "$(mktemp)")
[ -z "$WID" ] && pass "wrong password rejected" || fail "wrong password got session"

# 4. correct password → session
SID=$(login "$EMAIL" "$PW" "$J")
[ -n "$SID" ] && pass "password login establishes session" || fail "password login no session"

# 5. change password, then old fails / new works
NPW="staple-battery-horse"
CH=$(curl -s -b "$J" -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/auth/password" \
  -H 'content-type: application/json' \
  -d "{\"currentPassword\":\"$PW\",\"newPassword\":\"$NPW\"}")
assert "change password 200" "$CH" "200"
OLD=$(login "$EMAIL" "$PW" "$(mktemp)")
[ -z "$OLD" ] && pass "old password no longer works" || fail "old password still works"
NEW=$(login "$EMAIL" "$NPW" "$(mktemp)")
[ -n "$NEW" ] && pass "new password works" || fail "new password failed"

rm -f "$J"
if [ "$FAILED" -eq 0 ]; then echo "AUTH PASSWORD: PASS"; exit 0; else echo "AUTH PASSWORD: FAIL"; exit 1; fi

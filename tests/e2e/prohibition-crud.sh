#!/usr/bin/env bash
# P1.1 e2e — ProhibitionRule CRUD (rule-level prohibitions, distinct from
# ComplianceTerm word-level). Verifies create / list / patch / delete and
# positive/negative example asset attachment.
set -uo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
J="$(mktemp)"; FAILED=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
assert() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2' want '$3')"; fi; }
assert_ge() { if [ "$2" -ge "$3" ] 2>/dev/null; then pass "$1"; else fail "$1 (got '$2' want >=$3)"; fi; }

CSRF=$(curl -s -c "$J" "$BASE/api/auth/csrf" | jq -r .csrfToken)
curl -s -b "$J" -c "$J" -L -X POST "$BASE/api/auth/callback/credentials" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=e2e@brandai.dev" \
  --data-urlencode "callbackUrl=$BASE/workspaces" >/dev/null

WS=$(curl -s -b "$J" -X POST "$BASE/api/workspaces" -H 'content-type: application/json' \
  -d '{"name":"PR-CRUD","industry":"F&B","websiteUrl":"https://example.com"}' | jq -r '.id')
CAND=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/ingest" -H 'content-type: application/json' -d '{"url":"https://example.com"}')
curl -s -b "$J" -X PUT "$BASE/api/workspaces/$WS/ingest" -H 'content-type: application/json' \
  -d "$(echo "$CAND" | jq '{images:.images}')" >/dev/null
ASSETS=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/assets" | jq -c '[.[].id]')
POS=$(echo "$ASSETS" | jq -r '.[0] // empty')
NEG=$(echo "$ASSETS" | jq -r '.[1] // .[0]')

# CREATE
CREATE=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/prohibitions" -H 'content-type: application/json' \
  -d "{\"severity\":\"HIGH\",\"description\":\"禁止使用红色 Logo\",\"scope\":[\"logo\",\"color\"],\"positiveExampleAssetId\":\"$POS\",\"negativeExampleAssetId\":\"$NEG\",\"applicableChannels\":[\"ecom\"],\"alternativeSuggestion\":\"使用深灰色\"}")
PID=$(echo "$CREATE" | jq -r '.id // empty')
[ -n "$PID" ] && pass "prohibition created" || fail "create"

# LIST
LIST=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/prohibitions")
NL=$(echo "$LIST" | jq 'length')
assert_ge "prohibition list" "${NL:-0}" 1

# Check positive/negative example associations preserved
GOT_POS=$(echo "$LIST" | jq -r ".[] | select(.id==\"$PID\") | .positiveExampleAssetId")
GOT_NEG=$(echo "$LIST" | jq -r ".[] | select(.id==\"$PID\") | .negativeExampleAssetId")
assert "positiveExampleAssetId persisted" "$GOT_POS" "$POS"
assert "negativeExampleAssetId persisted" "$GOT_NEG" "$NEG"

# PATCH
PRESP=$(curl -s -b "$J" -X PATCH "$BASE/api/workspaces/$WS/prohibitions/$PID" -H 'content-type: application/json' \
  -d '{"severity":"LOW","status":"INACTIVE"}')
NSV=$(echo "$PRESP" | jq -r '.severity'); NST=$(echo "$PRESP" | jq -r '.status')
assert "PATCH severity=LOW" "$NSV" "LOW"
assert "PATCH status=INACTIVE" "$NST" "INACTIVE"

# DELETE
HTTP=$(curl -s -b "$J" -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/workspaces/$WS/prohibitions/$PID")
assert "DELETE returns 200" "$HTTP" "200"
N2=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/prohibitions" | jq 'length')
assert "list empty after delete" "$N2" "0"

rm -f "$J"
if [ "$FAILED" -eq 0 ]; then echo "PROHIBITION CRUD: PASS"; exit 0; else echo "PROHIBITION CRUD: FAIL"; exit 1; fi

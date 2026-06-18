#!/usr/bin/env bash
# P1.1 e2e — VI strong-typed `structured` payload round-trip.
# Create workspace → ingest → recognize → PATCH a color rule's `structured` →
# GET the rule back and confirm the structured payload survives the round trip.
set -uo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
J="$(mktemp)"
FAILED=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
assert() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2' want '$3')"; fi; }

CSRF=$(curl -s -c "$J" "$BASE/api/auth/csrf" | jq -r .csrfToken)
curl -s -b "$J" -c "$J" -L -X POST "$BASE/api/auth/callback/credentials" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=e2e@brandai.dev" \
  --data-urlencode "callbackUrl=$BASE/workspaces" >/dev/null

WS=$(curl -s -b "$J" -X POST "$BASE/api/workspaces" -H 'content-type: application/json' \
  -d '{"name":"VI-Field","industry":"F&B","websiteUrl":"https://example.com"}' | jq -r '.id // empty')
[ -n "$WS" ] && pass "workspace created" || { fail "workspace"; exit 1; }

CAND=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/ingest" -H 'content-type: application/json' -d '{"url":"https://example.com"}')
curl -s -b "$J" -X PUT "$BASE/api/workspaces/$WS/ingest" -H 'content-type: application/json' \
  -d "$(echo "$CAND" | jq '{images:.images}')" >/dev/null
AIDS=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/assets" | jq -c '[.[].id]')

JOB=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/rules/recognize" -H 'content-type: application/json' -d "{\"assetIds\":$AIDS}" | jq -r '.jobId')
for _ in $(seq 1 40); do
  ST=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/rules/recognize?jobId=$JOB" | jq -r '.status')
  [ "$ST" = "SUCCEEDED" ] && break; sleep 1
done
assert "recognize succeeded" "$ST" "SUCCEEDED"

COLOR_RULE=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/rules?type=color" | jq -r '.[0].id // empty')
[ -n "$COLOR_RULE" ] && pass "color rule present" || fail "color rule missing"

PAYLOAD='{"structured":{"deviation_threshold":7,"allow_gradient":false,"brightness_preference":"light"}}'
RESP=$(curl -s -b "$J" -X PATCH "$BASE/api/workspaces/$WS/rules/$COLOR_RULE" -H 'content-type: application/json' -d "$PAYLOAD")
STR_DT=$(echo "$RESP" | jq -r '.structured.deviation_threshold // empty')
STR_BP=$(echo "$RESP" | jq -r '.structured.brightness_preference // empty')
assert "PATCH echoes structured.deviation_threshold" "$STR_DT" "7"
assert "PATCH echoes structured.brightness_preference" "$STR_BP" "light"

# GET round-trip
GOT=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/rules" | jq -c ".[]|select(.id==\"$COLOR_RULE\")")
GOT_DT=$(echo "$GOT" | jq -r '.structured.deviation_threshold // empty')
GOT_MOD=$(echo "$GOT" | jq -r '.structured.module // empty')
assert "GET preserves structured.deviation_threshold" "$GOT_DT" "7"
assert "GET tags structured.module=color" "$GOT_MOD" "color"

# invalid payload should reject
HTTP=$(curl -s -b "$J" -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/workspaces/$WS/rules/$COLOR_RULE" -H 'content-type: application/json' \
  -d '{"structured":{"deviation_threshold":500}}')
assert "invalid structured payload rejected (400)" "$HTTP" "400"

rm -f "$J"
if [ "$FAILED" -eq 0 ]; then echo "VI-FIELD ROUNDTRIP: PASS"; exit 0; else echo "VI-FIELD ROUNDTRIP: FAIL"; exit 1; fi

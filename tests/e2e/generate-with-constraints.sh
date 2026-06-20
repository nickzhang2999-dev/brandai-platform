#!/usr/bin/env bash
# P1.2 e2e — AI constraint layer round-trip.
#
# Asserts:
#   1. A confirmed color BrandRule with structured.prohibited_combinations
#      lands in `appliedNegativePrompt` on every generated version.
#   2. An ACTIVE ProhibitionRule (severity=MEDIUM, affectsGeneration=true,
#      description "no neon") rides through into `appliedNegativePrompt`.
#   3. Adding a second prohibition with severity=HIGH aborts generation: the
#      Generation row flips to FAILED and `error` contains the blocker reason.
#
# Reuses the auth + workspace + ingest scaffolding from p0-flow.sh.
set -uo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
AI="${AI_URL:-http://localhost:8000}"
J="$(mktemp)"; FAILED=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
assert() { if [ "$2" = "$3" ]; then pass "$1 ($2)"; else fail "$1 (got '$2' want '$3')"; fi; }
assert_contains() { if echo "$2" | grep -q -- "$3"; then pass "$1 (matched '$3')"; else fail "$1 ('$2' does not contain '$3')"; fi; }

curl -s -m 5 "$AI/health" >/dev/null || { echo "AI service down at $AI"; exit 2; }
curl -s -m 5 "$BASE/api/health" >/dev/null || { echo "web down at $BASE"; exit 2; }

# auth
CSRF=$(curl -s -c "$J" "$BASE/api/auth/csrf" | jq -r .csrfToken)
curl -s -b "$J" -c "$J" -L -X POST "$BASE/api/auth/callback/credentials" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=e2e-cst-$$-$RANDOM@brandai.dev" \
  --data-urlencode "callbackUrl=$BASE/workspaces" >/dev/null

# workspace + ingest + assets
WS=$(curl -s -b "$J" -X POST "$BASE/api/workspaces" -H 'content-type: application/json' \
  -d '{"name":"P1.2-Constraints","industry":"F&B","websiteUrl":"https://example.com"}' | jq -r '.id')
[ -n "$WS" ] && pass "workspace created" || { fail "workspace"; exit 1; }
CAND=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/ingest" -H 'content-type: application/json' -d '{"url":"https://example.com"}')
curl -s -b "$J" -X PUT "$BASE/api/workspaces/$WS/ingest" -H 'content-type: application/json' \
  -d "$(echo "$CAND" | jq '{images:.images}')" >/dev/null
AIDS=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/assets" | jq -c '[.[].id]')

# recognize -> rules + confirm STRONG
JOB=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/rules/recognize" -H 'content-type: application/json' -d "{\"assetIds\":$AIDS}" | jq -r '.jobId')
for _ in $(seq 1 40); do
  ST=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/rules/recognize?jobId=$JOB" | jq -r '.status // empty')
  [ "$ST" = "SUCCEEDED" ] && break; sleep 1
done
assert "recognize finished" "$ST" "SUCCEEDED"
RULES=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/rules")
COLOR_ID=$(echo "$RULES" | jq -r '[.[]|select(.type=="color")][0].id // empty')
[ -n "$COLOR_ID" ] && pass "color rule present" || fail "color rule"

# Confirm all rules STRONG and patch the color one with prohibited_combinations
for rid in $(echo "$RULES" | jq -r '.[].id'); do
  curl -s -b "$J" -X PATCH "$BASE/api/workspaces/$WS/rules/$rid" -H 'content-type: application/json' \
    -d '{"status":"CONFIRMED","strength":"STRONG"}' >/dev/null
done
curl -s -b "$J" -X PATCH "$BASE/api/workspaces/$WS/rules/$COLOR_ID" -H 'content-type: application/json' \
  -d '{"structured":{"module":"color","prohibited_combinations":[["red","white"]]}}' >/dev/null
NEW_STRUCT=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/rules" | jq -r "[.[]|select(.id==\"$COLOR_ID\")][0].structured.prohibited_combinations[0]|join(\",\")")
assert "color.prohibited_combinations persisted" "$NEW_STRUCT" "red,white"

# Soft prohibition (MEDIUM) — should ride through into negativePrompt
PROH=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/prohibitions" -H 'content-type: application/json' \
  -d '{"severity":"MEDIUM","affectsGeneration":true,"description":"no neon","scope":["color"],"applicableChannels":["ecom"]}')
PID1=$(echo "$PROH" | jq -r '.id')
[ -n "$PID1" ] && pass "soft prohibition created" || fail "soft prohibition"

# project + first generation — expects SUCCEEDED with echo
PJ=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/projects" -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"name\":\"P1.2\",\"campaign\":\"S\",\"product\":\"CB\",\"channel\":\"电商\"}" | jq -r '.id')
GEN=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/generations" -H 'content-type: application/json' \
  -d "{\"projectId\":\"$PJ\",\"sceneType\":\"ECOM_MAIN\",\"sellingPoint\":\"低温慢萃\",\"scene\":\"门店\",\"versionCount\":2}")
GID=$(echo "$GEN" | jq -r '.generation.id'); GJOB=$(echo "$GEN" | jq -r '.jobId')
for _ in $(seq 1 50); do
  GS=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/generations/$GID?jobId=$GJOB")
  GST=$(echo "$GS" | jq -r '.generation.status'); [ "$GST" = "SUCCEEDED" ] && break
  [ "$GST" = "FAILED" ] && break; sleep 1
done
assert "generation succeeded with soft constraints" "$GST" "SUCCEEDED"
NEG=$(echo "$GS" | jq -c '.generation.versions[0].params.appliedNegativePrompt // []')
assert_contains "appliedNegativePrompt echoes 'no neon'" "$NEG" "no neon"
assert_contains "appliedNegativePrompt echoes prohibited color combo" "$NEG" "red"

# Hard block — add a HIGH-severity rule, regenerate, expect synchronous 422
# (preferred path) with a FAILED Generation row carrying the blocker reason.
curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/prohibitions" -H 'content-type: application/json' \
  -d '{"severity":"HIGH","affectsGeneration":true,"description":"absolute blocker","scope":["any"],"applicableChannels":["ecom"]}' >/dev/null
RESP_FILE="$(mktemp)"
HTTP=$(curl -s -b "$J" -o "$RESP_FILE" -w '%{http_code}' -X POST "$BASE/api/workspaces/$WS/generations" \
  -H 'content-type: application/json' \
  -d "{\"projectId\":\"$PJ\",\"sceneType\":\"ECOM_MAIN\",\"sellingPoint\":\"低温慢萃\",\"scene\":\"门店\",\"versionCount\":2}")
assert "hard-block returns 422" "$HTTP" "422"
BODY=$(cat "$RESP_FILE")
assert_contains "422 body mentions blocker" "$BODY" "absolute blocker"
# The blocked Generation row must persist as FAILED for audit.
GID2=$(echo "$BODY" | jq -r '.details.generationId // .generationId // empty')
if [ -n "$GID2" ]; then
  ROW=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/generations/$GID2")
  GST2=$(echo "$ROW" | jq -r '.generation.status // .status // empty')
  assert "blocked Generation row is FAILED" "$GST2" "FAILED"
  ERR=$(echo "$ROW" | jq -r '.generation.error // .error // ""')
  assert_contains "Generation.error mentions blocker" "$ERR" "absolute blocker"
fi
rm -f "$RESP_FILE"

rm -f "$J"
if [ "$FAILED" -eq 0 ]; then echo "P1.2 AI CONSTRAINTS: PASS"; exit 0; else echo "P1.2 AI CONSTRAINTS: FAIL"; exit 1; fi

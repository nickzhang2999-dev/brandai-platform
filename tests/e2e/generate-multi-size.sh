#!/usr/bin/env bash
# P2.0 e2e — multi-size batch 1→N adaptation.
#
# Asserts:
#   1. A single POST /generations with `targets` of 3 distinct sizes produces
#      exactly 3 GenerationVersion rows.
#   2. Their width/height match the requested sizes and are mutually distinct.
#   3. Each version carries params.targetKey / targetLabel.
#   4. The batch ends SUCCEEDED.
#
# Per-size failure isolation is covered by L1 (test_multi_size.py) / L2
# (multi-size.test.ts) since the mock provider does not fail.
#
# Reuses the auth + workspace scaffolding from p0-flow.sh.
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
  --data-urlencode "email=e2e-msz-$$-$RANDOM@brandai.dev" \
  --data-urlencode "callbackUrl=$BASE/workspaces" >/dev/null

# workspace + project
WS=$(curl -s -b "$J" -X POST "$BASE/api/workspaces" -H 'content-type: application/json' \
  -d '{"name":"P2.0-MultiSize","industry":"F&B","websiteUrl":"https://example.com"}' | jq -r '.id')
[ -n "$WS" ] && pass "workspace created" || { fail "workspace"; exit 1; }
PJ=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/projects" -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"name\":\"P2.0\",\"campaign\":\"S\",\"product\":\"CB\",\"channel\":\"全渠道\"}" | jq -r '.id')
[ -n "$PJ" ] && pass "project created" || { fail "project"; exit 1; }

# Submit a generation with THREE distinct target sizes in one request.
TARGETS='[{"key":"xhs_cover","label":"小红书封面","width":1080,"height":1440},{"key":"ecom_main","label":"电商主图","width":1024,"height":1024},{"key":"banner","label":"Banner","width":1920,"height":1080}]'
GEN=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/generations" -H 'content-type: application/json' \
  -d "{\"projectId\":\"$PJ\",\"sceneType\":\"ECOM_MAIN\",\"sellingPoint\":\"低温慢萃\",\"scene\":\"门店\",\"versionCount\":4,\"targets\":$TARGETS}")
GID=$(echo "$GEN" | jq -r '.generation.id'); GJOB=$(echo "$GEN" | jq -r '.jobId')
[ -n "$GID" ] && pass "multi-size generation enqueued" || { fail "enqueue"; exit 1; }

for _ in $(seq 1 60); do
  GS=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/generations/$GID?jobId=$GJOB")
  GST=$(echo "$GS" | jq -r '.generation.status'); [ "$GST" = "SUCCEEDED" ] && break
  [ "$GST" = "FAILED" ] && break; sleep 1
done
assert "multi-size batch succeeded" "$GST" "SUCCEEDED"

# Exactly 3 versions (versionCount=4 ignored when targets present).
NV=$(echo "$GS" | jq -r '.generation.versions | length')
assert "produced 3 versions (one per target)" "$NV" "3"

# Sizes match the request and are mutually distinct.
DIMS=$(echo "$GS" | jq -c '[.generation.versions[] | "\(.width)x\(.height)"] | sort')
assert_contains "has 1080x1440" "$DIMS" "1080x1440"
assert_contains "has 1024x1024" "$DIMS" "1024x1024"
assert_contains "has 1920x1080" "$DIMS" "1920x1080"
UNIQ=$(echo "$GS" | jq -r '[.generation.versions[] | "\(.width)x\(.height)"] | unique | length')
assert "all 3 sizes distinct" "$UNIQ" "3"

# Each version carries the target metadata.
KEYS=$(echo "$GS" | jq -c '[.generation.versions[].params.targetKey] | sort')
assert_contains "params.targetKey present (xhs_cover)" "$KEYS" "xhs_cover"
assert_contains "params.targetKey present (banner)" "$KEYS" "banner"
LABELS=$(echo "$GS" | jq -c '[.generation.versions[].params.targetLabel]')
assert_contains "params.targetLabel present" "$LABELS" "小红书封面"

rm -f "$J"
if [ "$FAILED" -eq 0 ]; then echo "P2.0 MULTI-SIZE: PASS"; exit 0; else echo "P2.0 MULTI-SIZE: FAIL"; exit 1; fi

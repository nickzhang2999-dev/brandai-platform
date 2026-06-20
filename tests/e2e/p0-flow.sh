#!/usr/bin/env bash
# AUTHORITATIVE P0 END-TO-END TEST.
#
# Drives the full Definition-of-Done loop against a running stack and FAILS
# (exit 1) on the first broken assertion. No hardcoded success line.
#
# Prereqs (see docs/TESTING.md): docker infra up, db migrated+seeded,
# AI service on :8000, web `pnpm start` on :3000, worker running.
#   BASE_URL (default http://localhost:3000), AI_URL (default :8000)
set -uo pipefail

BASE="${BASE_URL:-http://localhost:3000}"
AI="${AI_URL:-http://localhost:8000}"
J="$(mktemp)"
FAILED=0

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
assert() { # <desc> <actual> <expected>
  if [ "$2" = "$3" ]; then pass "$1 ($2)"; else fail "$1 (got '$2' want '$3')"; fi
}
assert_ge() { if [ "$2" -ge "$3" ] 2>/dev/null; then pass "$1 ($2>=$3)"; else fail "$1 (got '$2' want >=$3)"; fi; }

curl -s -m 5 "$AI/health" >/dev/null || { echo "AI service down at $AI"; exit 2; }
curl -s -m 5 "$BASE/api/health" >/dev/null || { echo "web down at $BASE"; exit 2; }

# 1. auth (next-auth credentials)
CSRF=$(curl -s -c "$J" "$BASE/api/auth/csrf" | jq -r .csrfToken)
curl -s -b "$J" -c "$J" -L -X POST "$BASE/api/auth/callback/credentials" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=e2e-p0-$$-$RANDOM@brandai.dev" \
  --data-urlencode "callbackUrl=$BASE/workspaces" >/dev/null
USR=$(curl -s -b "$J" "$BASE/api/auth/session" | jq -r '.user.id // empty')
[ -n "$USR" ] && pass "auth session established" || fail "auth session"

# 2. M1 workspace + website ingest
WS=$(curl -s -b "$J" -X POST "$BASE/api/workspaces" -H 'content-type: application/json' \
  -d '{"name":"E2E","industry":"F&B","websiteUrl":"https://example.com"}' | jq -r '.id // empty')
[ -n "$WS" ] && pass "M1 workspace created" || { fail "M1 workspace"; echo "ABORT"; exit 1; }
CAND=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/ingest" -H 'content-type: application/json' -d '{"url":"https://example.com"}')
curl -s -b "$J" -X PUT "$BASE/api/workspaces/$WS/ingest" -H 'content-type: application/json' \
  -d "$(echo "$CAND" | jq '{images:.images}')" >/dev/null
NA=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/assets" | jq 'length')
assert_ge "M1 assets persisted from website" "${NA:-0}" 1
AIDS=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/assets" | jq -c '[.[].id]')

# 3. M2 recognize -> rules with evidence -> confirm
JOB=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/rules/recognize" -H 'content-type: application/json' -d "{\"assetIds\":$AIDS}" | jq -r '.jobId // empty')
for _ in $(seq 1 40); do
  ST=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/rules/recognize?jobId=$JOB" | jq -r '.status // .state // empty')
  [ "$ST" = "SUCCEEDED" ] && break; sleep 1
done
assert "M2 recognize job" "$ST" "SUCCEEDED"
RULES=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/rules")
NR=$(echo "$RULES" | jq 'length'); assert_ge "M2 DRAFT rules" "${NR:-0}" 1
WITH_EV=$(echo "$RULES" | jq '[.[]|select((.evidence|length)>0)]|length')
assert "M2 every rule has evidence" "$WITH_EV" "$NR"
for rid in $(echo "$RULES" | jq -r '.[].id'); do
  curl -s -b "$J" -X PATCH "$BASE/api/workspaces/$WS/rules/$rid" -H 'content-type: application/json' -d '{"status":"CONFIRMED","strength":"STRONG"}' >/dev/null
done
NC=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/rules" | jq '[.[]|select(.status=="CONFIRMED")]|length')
assert "M2 rules confirmed" "$NC" "$NR"

# 4. M5 term + precheck (FORBIDDEN expected)
curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/terms" -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"type\":\"FORBIDDEN\",\"term\":\"第一\",\"reason\":\"绝对化\",\"replacement\":\"领先\"}" >/dev/null
PCO=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/compliance/precheck" -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"text\":\"全网第一，100%有效\"}" | jq -r '.report.overall // empty')
assert "M5 precheck blocks forbidden copy" "$PCO" "FORBIDDEN"

# 5. M6 project + M3 generate
PJ=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/projects" -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"name\":\"E2E P\",\"campaign\":\"S\",\"product\":\"CB\",\"channel\":\"电商\"}" | jq -r '.id // empty')
[ -n "$PJ" ] && pass "M6 project created" || fail "M6 project"
GEN=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/generations" -H 'content-type: application/json' \
  -d "{\"projectId\":\"$PJ\",\"sceneType\":\"ECOM_MAIN\",\"sellingPoint\":\"低温慢萃\",\"scene\":\"门店\",\"versionCount\":3}")
GID=$(echo "$GEN" | jq -r '.generation.id'); GJOB=$(echo "$GEN" | jq -r '.jobId')
for _ in $(seq 1 50); do
  GS=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/generations/$GID?jobId=$GJOB")
  GST=$(echo "$GS" | jq -r '.generation.status'); [ "$GST" = "SUCCEEDED" ] && break; sleep 1
done
assert "M3 generation job" "$GST" "SUCCEEDED"
NV=$(echo "$GS" | jq '.generation.versions|length'); assert "M3 multi-version output" "$NV" "3"
V1=$(echo "$GS" | jq -r '.generation.versions[0].id')

# 6. M4 edit -> child version
ED=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/generations/$GID/versions/$V1/edit" \
  -H 'content-type: application/json' -d '{"op":"RESIZE","payload":{"width":1080,"height":1350}}')
EJOB=$(echo "$ED" | jq -r '.jobId')
for _ in $(seq 1 40); do
  ES=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/generations/$GID/versions/$V1/edit?jobId=$EJOB")
  EST=$(echo "$ES" | jq -r '.job.status // empty'); [ "$EST" = "SUCCEEDED" ] && break; sleep 1
done
assert "M4 edit job" "$EST" "SUCCEEDED"
NLIN=$(echo "$ES" | jq '.lineage.versions|length')
assert_ge "M4 edit produced child version" "${NLIN:-0}" 4

# 7. mark final + M6 delivery export
curl -s -b "$J" -X PATCH "$BASE/api/workspaces/$WS/generations/$GID" -H 'content-type: application/json' -d "{\"versionId\":\"$V1\",\"isFinal\":true}" >/dev/null
ZIP="$(mktemp).zip"
HTTP=$(curl -s -b "$J" -o "$ZIP" -w '%{http_code}' -X POST "$BASE/api/workspaces/$WS/projects/$PJ/export" \
  -H 'content-type: application/json' -d "{\"versionIds\":[\"$V1\"]}")
assert "M6 delivery export HTTP" "$HTTP" "200"
ENTRIES=$(unzip -l "$ZIP" 2>/dev/null | tail -1 | awk '{print $2}')
assert_ge "M6 delivery package entries" "${ENTRIES:-0}" 4
unzip -l "$ZIP" 2>/dev/null | grep -q "rules.json" && pass "M6 package has rules.json" || fail "M6 rules.json"
unzip -l "$ZIP" 2>/dev/null | grep -q "manifest.json" && pass "M6 package has manifest.json" || fail "M6 manifest.json"

rm -f "$J" "$ZIP"
echo "------------------------------------------------------------"
if [ "$FAILED" -eq 0 ]; then echo "P0 E2E: ALL ASSERTIONS PASSED"; exit 0
else echo "P0 E2E: FAILURES DETECTED"; exit 1; fi

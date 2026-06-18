#!/usr/bin/env bash
# P1.3 e2e — Asset availability lifecycle. Mark an asset deprecated; verify
# recognize route refuses to enqueue it (no matching assets in this workspace).
set -uo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
J="$(mktemp)"; FAILED=0
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
  -d '{"name":"AVL","industry":"F&B","websiteUrl":"https://example.com"}' | jq -r '.id')
CAND=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/ingest" -H 'content-type: application/json' -d '{"url":"https://example.com"}')
curl -s -b "$J" -X PUT "$BASE/api/workspaces/$WS/ingest" -H 'content-type: application/json' \
  -d "$(echo "$CAND" | jq '{images:.images}')" >/dev/null
ASSETS=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/assets")
AID=$(echo "$ASSETS" | jq -r '.[0].id')

# Initial availability defaults to true
DEFAULT=$(echo "$ASSETS" | jq -r '.[0].availableForGeneration')
assert "default availableForGeneration=true" "$DEFAULT" "true"

# Deprecate the asset.
DEP=$(curl -s -b "$J" -X PATCH "$BASE/api/workspaces/$WS/assets/$AID" -H 'content-type: application/json' \
  -d '{"availableForGeneration":false,"deprecatedAt":"2026-01-01T00:00:00.000Z"}')
AFG=$(echo "$DEP" | jq -r '.availableForGeneration')
DAT=$(echo "$DEP" | jq -r '.deprecatedAt')
assert "PATCH availableForGeneration=false" "$AFG" "false"
[ "$DAT" != "null" ] && pass "deprecatedAt set" || fail "deprecatedAt"

# Recognize must refuse a workspace with only deprecated assets.
HTTP=$(curl -s -b "$J" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/workspaces/$WS/rules/recognize" \
  -H 'content-type: application/json' -d "{\"assetIds\":[\"$AID\"]}")
assert "recognize refuses deprecated assets (400)" "$HTTP" "400"

# Revive
REV=$(curl -s -b "$J" -X PATCH "$BASE/api/workspaces/$WS/assets/$AID" -H 'content-type: application/json' \
  -d '{"availableForGeneration":true,"deprecatedAt":null}')
RAFG=$(echo "$REV" | jq -r '.availableForGeneration')
RDAT=$(echo "$REV" | jq -r '.deprecatedAt')
assert "revive availableForGeneration=true" "$RAFG" "true"
assert "deprecatedAt cleared" "$RDAT" "null"

# Now recognize accepts the asset (don't wait for job).
HTTP2=$(curl -s -b "$J" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/workspaces/$WS/rules/recognize" \
  -H 'content-type: application/json' -d "{\"assetIds\":[\"$AID\"]}")
assert "recognize accepts revived asset (202)" "$HTTP2" "202"

rm -f "$J"
if [ "$FAILED" -eq 0 ]; then echo "ASSET AVAILABILITY: PASS"; exit 0; else echo "ASSET AVAILABILITY: FAIL"; exit 1; fi

#!/usr/bin/env bash
# M-A e2e — Asset public proxy roundtrip (DoD D1). Ingest a website asset,
# then fetch it through the same-origin proxy route and assert the BFF relays
# the bytes (200 + image-ish content-type) instead of handing the browser an
# unreachable storage URL. Also asserts ownership: a foreign asset id 404s.
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
  -d '{"name":"PROXY","industry":"F&B","websiteUrl":"https://example.com"}' | jq -r '.id')
CAND=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/ingest" -H 'content-type: application/json' -d '{"url":"https://example.com"}')
curl -s -b "$J" -X PUT "$BASE/api/workspaces/$WS/ingest" -H 'content-type: application/json' \
  -d "$(echo "$CAND" | jq '{images:.images}')" >/dev/null
ASSETS=$(curl -s -b "$J" "$BASE/api/workspaces/$WS/assets")
AID=$(echo "$ASSETS" | jq -r '.[0].id')
[ "$AID" != "null" ] && pass "asset ingested ($AID)" || fail "no asset ingested"

# Proxy serves the bytes over the public/same-origin route.
HDRS=$(curl -s -b "$J" -D - -o /dev/null "$BASE/api/workspaces/$WS/assets/$AID/raw")
CODE=$(echo "$HDRS" | head -1 | awk '{print $2}')
CT=$(echo "$HDRS" | grep -i '^content-type:' | head -1 | tr -d '\r' | awk '{print $2}')
assert "proxy returns 200" "$CODE" "200"
case "$CT" in
  image/*|application/octet-stream) pass "proxy content-type is bytes ($CT)" ;;
  *) fail "proxy content-type ($CT)" ;;
esac

# Ownership: an unknown asset id under this workspace 404s.
HTTP404=$(curl -s -b "$J" -o /dev/null -w '%{http_code}' "$BASE/api/workspaces/$WS/assets/does-not-exist/raw")
assert "unknown asset id 404" "$HTTP404" "404"

# Unauthenticated request must not stream bytes (401/redirect, not 200).
HTTPNA=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/workspaces/$WS/assets/$AID/raw")
[ "$HTTPNA" != "200" ] && pass "unauthenticated denied ($HTTPNA)" || fail "unauthenticated got 200"

rm -f "$J"
if [ "$FAILED" -eq 0 ]; then echo "ASSET PROXY ROUNDTRIP: PASS"; exit 0; else echo "ASSET PROXY ROUNDTRIP: FAIL"; exit 1; fi

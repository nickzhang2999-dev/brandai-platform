#!/usr/bin/env bash
# M-D e2e — Generation quota / rate-limit (D4) on the STARTER free tier (D5).
# A fresh user defaults to STARTER (daily limit 5). Five generations enqueue
# (202); the sixth is refused with 402. Uses a unique per-run email so the
# count is isolated and never collides with other suites or re-runs.
#
# Requires QUOTA_V1 enabled (default). When QUOTA_V1=0 this is a no-op pass.
set -uo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
EMAIL="e2e-quota-$$-$RANDOM@brandai.dev"
J="$(mktemp)"; FAILED=0
pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }
assert() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2' want '$3')"; fi; }

CSRF=$(curl -s -c "$J" "$BASE/api/auth/csrf" | jq -r .csrfToken)
curl -s -b "$J" -c "$J" -L -X POST "$BASE/api/auth/callback/credentials" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=$EMAIL" \
  --data-urlencode "callbackUrl=$BASE/workspaces" >/dev/null

SUB=$(curl -s -b "$J" "$BASE/api/me/subscription")
ENABLED=$(echo "$SUB" | jq -r '.enabled')
if [ "$ENABLED" != "true" ]; then
  echo "QUOTA disabled (QUOTA_V1=0) — skipping"; echo "GENERATION QUOTA: PASS"; rm -f "$J"; exit 0
fi
assert "fresh user defaults to STARTER" "$(echo "$SUB" | jq -r '.plan.tier')" "STARTER"
LIMIT=$(echo "$SUB" | jq -r '.plan.dailyGenerationLimit')
assert "starter daily limit is 5" "$LIMIT" "5"
assert "initial daily usage is 0" "$(echo "$SUB" | jq -r '.usage.dailyUsed')" "0"

WS=$(curl -s -b "$J" -X POST "$BASE/api/workspaces" -H 'content-type: application/json' \
  -d '{"name":"QUOTA","industry":"F&B","websiteUrl":"https://example.com"}' | jq -r '.id')
PJ=$(curl -s -b "$J" -X POST "$BASE/api/workspaces/$WS/projects" -H 'content-type: application/json' \
  -d "{\"workspaceId\":\"$WS\",\"name\":\"Q\",\"campaign\":\"S\",\"product\":\"CB\",\"channel\":\"电商\"}" | jq -r '.id')

gen() { curl -s -b "$J" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/workspaces/$WS/generations" \
  -H 'content-type: application/json' \
  -d "{\"projectId\":\"$PJ\",\"sceneType\":\"ECOM_MAIN\",\"sellingPoint\":\"低温慢萃\",\"scene\":\"门店\",\"versionCount\":1}"; }

OK=0
for i in $(seq 1 "$LIMIT"); do
  CODE=$(gen)
  [ "$CODE" = "202" ] && OK=$((OK+1)) || fail "generation #$i expected 202 (got $CODE)"
done
assert "first $LIMIT generations accepted" "$OK" "$LIMIT"

# One past the limit → 402.
OVER=$(gen)
assert "over-limit generation refused (402)" "$OVER" "402"

# Usage reflects the consumed quota.
USED=$(curl -s -b "$J" "$BASE/api/me/subscription" | jq -r '.usage.dailyUsed')
assert "daily usage equals limit" "$USED" "$LIMIT"

rm -f "$J"
if [ "$FAILED" -eq 0 ]; then echo "GENERATION QUOTA: PASS"; exit 0; else echo "GENERATION QUOTA: FAIL"; exit 1; fi

#!/usr/bin/env bash
# Recapture the golden AI fixtures used by packages/contracts contract tests.
# Run with the AI service up (AI_URL default http://localhost:8000).
set -euo pipefail
AI="${AI_URL:-http://localhost:8000}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/packages/contracts/tests/fixtures"
mkdir -p "$OUT"
post() { curl -s -X POST "$AI$1" -H 'content-type: application/json' -d "$2"; }

post /v1/ingest/website '{"url":"https://example.com"}' > "$OUT/ingest.json"
post /v1/recognize '{"assets":[{"id":"a1","url":"http://x/y.png"}]}' > "$OUT/recognize.json"
post /v1/generate '{"sceneType":"CAMPAIGN_KV","sellingPoint":"新品","scene":"门店","brandRules":[],"versionCount":2}' > "$OUT/generate.json"
post /v1/edit '{"imageUrl":"http://x/y.png","op":"OUTPAINT","payload":{}}' > "$OUT/edit.json"
post /v1/compliance/check '{"text":"全网第一","imageUrl":"http://x/y.png","brandRules":[],"termLib":[{"type":"CAUTION","term":"顶级","reason":"需确认"}]}' > "$OUT/compliance.json"
echo "fixtures written to $OUT"

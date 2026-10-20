#!/usr/bin/env bash
# Project-owned release contract. CDS must execute this exact committed file.
set -Eeuo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

check() {
  bash -n ./cds-release.sh
  node --test scripts/test-novart-production.mjs
}

case "${1:-}" in
  check)
    check
    ;;
  deploy)
    : "${CDS_COMMIT_SHA:?Full release commit required}" "${CDS_RELEASE_ID:?Release ID required}" "${CDS_TARGET_ID:?Target ID required}"
    node --input-type=module -e "import {verifyReleaseIdentity} from './deploy/novart/production/verify.mjs'; verifyReleaseIdentity()"
    test "$(git rev-parse HEAD)" = "$CDS_COMMIT_SHA" || { echo 'Release checkout does not match requested commit' >&2; exit 1; }
    test "$CDS_TARGET_ID" = 'brandai-novartlab-local-prod' || { echo 'Unexpected production target' >&2; exit 1; }
    check
    docker compose -p brandai-prod -f deploy/novart/production/compose.yml config --quiet
    # Verify baked identities before touching production. Runtime env is not proof.
    for service in web ai; do
      image="ghcr.io/nickzhang2999-dev/brandai-platform/novart-product-${service}:sha-${CDS_COMMIT_SHA}"
      docker pull "$image"
      docker image inspect "$image" --format '{{json .Config.Env}}' | node --input-type=module -e 'import fs from "node:fs"; import {verifyImageIdentity} from "./deploy/novart/production/verify.mjs"; verifyImageIdentity(JSON.parse(fs.readFileSync(0,"utf8")),process.env.CDS_COMMIT_SHA)'
    done
    docker compose -p brandai-prod -f deploy/novart/production/compose.yml up -d --remove-orphans
    docker compose -p brandai-prod -f deploy/novart/production/compose.yml logs --no-color release-check
    for origin in https://deepflare.cn https://deepflare.com.cn https://www.novartlab.com; do
      docker compose -p brandai-prod -f deploy/novart/production/compose.yml exec -T -e "NOVART_VERIFY_ORIGIN=$origin" -e "CDS_RELEASE_ID=$CDS_RELEASE_ID" web node /release/verify.mjs served
    done
    printf 'Project release completed: %s (%s)\n' "$CDS_COMMIT_SHA" "$CDS_RELEASE_ID"
    ;;
  *)
    echo 'Usage: bash cds-release.sh check | deploy' >&2
    exit 64
    ;;
esac

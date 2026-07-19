#!/bin/sh
# Production-safe Prisma deployment for databases that predate migration
# tracking. Existing CDS environments were originally provisioned with
# `prisma db push`, so they can contain the current schema without a populated
# `_prisma_migrations` table. Prisma reports P3005 in that state.
#
# Safety contract:
# - Normal path is exactly `prisma migrate deploy`.
# - Baseline only on the exact P3005 error.
# - Baseline records repository migrations as applied; it never executes DDL,
#   drops columns, or passes --accept-data-loss.
# - Any other error is returned unchanged.
set -eu

SCHEMA_PATH="prisma/schema.prisma"
MIGRATIONS_DIR="prisma/migrations"
DEPLOY_LOG=$(mktemp "${TMPDIR:-/tmp}/brandai-prisma-deploy.XXXXXX")
trap 'rm -f "$DEPLOY_LOG"' EXIT INT TERM

run_deploy() {
  set +e
  pnpm exec prisma migrate deploy --schema "$SCHEMA_PATH" >"$DEPLOY_LOG" 2>&1
  DEPLOY_RC=$?
  set -e
  sed -n '1,240p' "$DEPLOY_LOG"
  return "$DEPLOY_RC"
}

if run_deploy; then
  exit 0
fi

if ! grep -Eq '^Error: P3005\r?$' "$DEPLOY_LOG"; then
  echo "[db-deploy] migrate deploy failed without P3005; refusing to baseline" >&2
  exit "$DEPLOY_RC"
fi

echo "[db-deploy] P3005 detected: baselining existing non-empty database"
BASELINED=0
for MIGRATION_SQL in "$MIGRATIONS_DIR"/*/migration.sql; do
  [ -f "$MIGRATION_SQL" ] || continue
  MIGRATION_DIR=${MIGRATION_SQL%/migration.sql}
  MIGRATION_NAME=${MIGRATION_DIR##*/}
  echo "[db-deploy] mark applied: $MIGRATION_NAME"
  pnpm exec prisma migrate resolve \
    --schema "$SCHEMA_PATH" \
    --applied "$MIGRATION_NAME"
  BASELINED=$((BASELINED + 1))
done

if [ "$BASELINED" -eq 0 ]; then
  echo "[db-deploy] no migration files found; refusing to continue" >&2
  exit 1
fi

echo "[db-deploy] baseline complete ($BASELINED migrations); verifying deploy"
run_deploy

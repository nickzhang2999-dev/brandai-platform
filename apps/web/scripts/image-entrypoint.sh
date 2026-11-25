#!/bin/sh
# CDS can replace the worker command with one that migrates before starting.
# Validate the target before handing any command to the upstream Node entrypoint.
set -eu
if [ "${VITE_GIT_BRANCH:-}" = df-2-sol ] || [ "${CDS_BRANCH_NAME:-}" = df-2-sol ] || [ "${NOVART_DATA_SCOPE:-}" = novart_preview_df_2_sol ]; then
  exec sh /app/apps/web/scripts/start-sol-preview.sh guarded-command "$@"
fi
exec docker-entrypoint.sh "$@"

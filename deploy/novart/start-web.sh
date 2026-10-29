#!/bin/sh
set -eu
# Validate before Prisma can modify any database, using no installed dependency.
node apps/web/scripts/check-runtime-security.mjs
# An explicit branch-local origin wins over a legacy CDS mode's hard-coded
# AUTH_URL. Without it, existing main/production startup stays unchanged.
if [ -n "${NOVART_PUBLIC_ORIGIN:-}" ]; then
  AUTH_URL=$(node apps/web/scripts/resolve-preview-origin.mjs)
  export AUTH_URL
fi
# No installs or builds on CDS. Fail before serving when migration cannot finish.
pnpm -F @brandai/db exec prisma migrate deploy
exec pnpm -F web start

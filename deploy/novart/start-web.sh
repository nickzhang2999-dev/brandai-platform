#!/bin/sh
set -eu
# Validate before Prisma can modify any database, using no installed dependency.
node apps/web/scripts/check-runtime-security.mjs
# No installs or builds on CDS. Fail before serving when migration cannot finish.
pnpm -F @brandai/db exec prisma migrate deploy
exec pnpm -F web start

#!/bin/sh
set -eu
# No installs or builds on CDS. Fail before serving when migration cannot finish.
pnpm -F @brandai/db exec prisma migrate deploy
exec pnpm -F web start

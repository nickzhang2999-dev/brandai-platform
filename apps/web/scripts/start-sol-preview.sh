#!/bin/sh
# Consume the existing CDS database binding without persisting credentials in a profile override.
set -eu
cd /app
test "${VITE_GIT_BRANCH:-}" = df-2-sol
test "${NOVART_DATA_SCOPE:-}" = novart_preview_df_2_sol
test "${BRANDAI_QUEUE_PREFIX:-}" = brandai-df-2-sol
DATABASE_URL=$(node --input-type=module -e '
  import { assertRuntimeDataScope } from "./apps/web/runtime-data-scope.mjs";
  try {
    const url = new URL(process.env.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
    const schema = url.searchParams.get("schema");
    if (schema && schema !== "public" && schema !== process.env.NOVART_DATA_SCOPE) throw new Error();
    url.searchParams.set("schema", process.env.NOVART_DATA_SCOPE);
    assertRuntimeDataScope({ ...process.env, DATABASE_URL: url.href });
    process.stdout.write(url.href);
  } catch { process.exitCode = 1; }
')
export DATABASE_URL
case "${1:-}" in
  guarded-command) shift; exec docker-entrypoint.sh "$@" ;;
  web) exec sh deploy/novart/start-web.sh ;;
  worker) exec pnpm -F web worker ;;
  *) exit 2 ;;
esac

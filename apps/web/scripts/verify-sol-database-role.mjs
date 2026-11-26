import { createRequire } from "node:module";

const { PrismaClient } = createRequire(new URL("../../../packages/db/package.json", import.meta.url))("@prisma/client");
const scope = "novart_preview_df_2_sol";

// Check the authenticated database identity. A schema in a URL also works with
// a privileged shared account and alone cannot protect the production tables.
let db;
try {
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("connect_timeout", "5");
  url.searchParams.set("socket_timeout", "5");
  db = new PrismaClient({ datasourceUrl: url.href });
  const [row] = await db.$queryRaw`
    WITH reachable AS (
      SELECT oid, rolsuper, rolcreaterole, rolcreatedb, rolreplication FROM pg_catalog.pg_roles
      WHERE pg_catalog.pg_has_role(session_user, oid, 'MEMBER')
    )
    SELECT current_user = session_user
      AND current_schema() = ${scope}
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
                  WHERE n.nspname=${scope} AND r.rolname=session_user)
      AND NOT EXISTS (SELECT 1 FROM reachable r
                      WHERE r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication
                         OR pg_catalog.has_schema_privilege(r.oid, 'public', 'CREATE'))
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        CROSS JOIN reachable r WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
          AND (c.relowner=r.oid OR pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
               OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE'))
      ) AS allowed
  `;
  if (row?.allowed !== true) throw new Error();
} catch {
  console.error("Preview database identity is unavailable or has permissions outside the permitted scope.");
  process.exitCode = 1;
} finally {
  await db?.$disconnect();
}

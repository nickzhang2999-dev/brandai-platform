/**
 * Hermetic SQL regression: replays the checked-in migration history in an
 * in-memory PGlite database and uses synthetic tenants only. Does not read env,
 * accept a DATABASE_URL, or connect to a server. Install PGlite outside the repo
 * and pass its dist/index.js explicitly:
 * node --wasm-num-compilation-tasks=1 --liftoff-only --no-wasm-tier-up \
 *   scripts/test-p5-workspace-fk.mjs <absolute-path-to-pglite/dist/index.js>
 *
 * This validates PostgreSQL SQL/constraints, not native PostgreSQL deployment,
 * Prisma migrate, real orphan counts, provider calls, or application E2E.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const modulePath = process.argv[2];
if (!modulePath || !isAbsolute(modulePath) || process.argv.length !== 3) {
  throw new Error("Pass exactly one absolute PGlite module path; this test accepts no database connection URL.");
}
const { PGlite } = await import(pathToFileURL(resolve(modulePath)).href);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsRoot = join(repo, "packages/db/prisma/migrations");
const candidateName = "20261016090000_workspace_fk_indexes";
const candidate = await readFile(join(migrationsRoot, candidateName, "migration.sql"), "utf8");
const auditSql = await readFile(join(repo, "scripts/sql/p5-workspace-orphan-audit.sql"), "utf8");
const database = new PGlite();
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions += 1; };
const count = async (table, where = "TRUE") => Number((await database.query(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`)).rows[0].n);
const audit = async () => {
  const results = await database.exec(auditSql);
  return {
    orphans: Object.fromEntries(results.flatMap((result) => result.rows).filter((row) => "table_name" in row).map((row) => [row.table_name, Number(row.orphan_count)])),
    mismatches: Object.fromEntries(results.flatMap((result) => result.rows).filter((row) => "relation_name" in row).map((row) => [row.relation_name, Number(row.mismatch_count)])),
  };
};
const applyCandidate = async () => {
  try { await database.exec(candidate); }
  catch (error) { await database.exec("ROLLBACK"); throw error; }
};
const expectSqlError = async (operation, code, message) => {
  await assert.rejects(operation, (error) => error.code === code, message);
  assertions += 1;
};

try {
  const migrationNames = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== candidateName).map((entry) => entry.name).sort();
  for (const migrationName of migrationNames) {
    try { await database.exec(await readFile(join(migrationsRoot, migrationName, "migration.sql"), "utf8")); }
    catch (error) { throw new Error(`Baseline migration failed: ${migrationName}`, { cause: error }); }
  }
  const initialAudit = await audit();
  check(Object.keys(initialAudit.orphans).length === 26, "Audit includes all 26 workspaceId tables");
  check(Object.values(initialAudit.orphans).every((value) => value === 0), "Empty synthetic DB has no orphan rows");
  check(Object.keys(initialAudit.mismatches).length === 6, "Audit covers six cascade-scope paths");

  await database.exec(`
    INSERT INTO "User" (id, email) VALUES ('fixture-user', 'p5-synthetic@example.invalid');
    INSERT INTO "BrandWorkspace" (id, "ownerId", name) VALUES
      ('workspace-a', 'fixture-user', 'Synthetic A'), ('workspace-b', 'fixture-user', 'Synthetic B');
    INSERT INTO "Membership" (id, "userId", "workspaceId") VALUES
      ('membership-a', 'fixture-user', 'workspace-a'), ('membership-b', 'fixture-user', 'workspace-b');
    INSERT INTO "Project" (id, "workspaceId", name) VALUES
      ('project-a', 'workspace-a', 'Project A'), ('project-b', 'workspace-b', 'Project B');
    INSERT INTO "Generation" (id, "projectId", "workspaceId", "sceneType", "sellingPoint", scene) VALUES
      ('generation-a', 'project-a', 'workspace-a', 'SCENE', 'fixture', 'fixture'),
      ('generation-b', 'project-b', 'workspace-b', 'SCENE', 'fixture', 'fixture');
    INSERT INTO "AsyncTask" (id, "workspaceId", kind, "updatedAt") VALUES
      ('upload-a', 'workspace-a', 'STUDIO_MATERIAL_UPLOAD', CURRENT_TIMESTAMP),
      ('receipt-a', 'workspace-a', 'STUDIO_BRAND_MATERIAL', CURRENT_TIMESTAMP);
    INSERT INTO "Asset" (id, "workspaceId", category, "fileName", "storageKey", url, "mimeType") VALUES
      ('asset-a', 'workspace-a', 'OTHER', 'fixture.png', 'workspace-a/fixture.png', 'https://example.invalid/fixture.png', 'image/png');
    INSERT INTO "StudioMaterialUpload" ("taskId", "workspaceId", "userId", "projectId", "mutationId", sha256, "fileName", "mimeType", "sizeBytes", "objectKey", "expiresAt") VALUES
      ('upload-a', 'workspace-a', 'fixture-user', 'project-a', 'upload-mutation', '${"a".repeat(64)}', 'pending.png', 'image/png', 32, 'workspace-a/pending.png', CURRENT_TIMESTAMP + INTERVAL '1 hour');
    INSERT INTO "StudioBrandMaterialReceipt" ("assetId", "workspaceId", "userId", "taskId", "mimeType", "sizeBytes", "sourceDigest", "expiresAt", "updatedAt") VALUES
      ('asset-a', 'workspace-a', 'fixture-user', 'receipt-a', 'image/png', 32, '${"a".repeat(64)}', CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP);
    INSERT INTO "StudioGenerationRequest" (id, "workspaceId", "userId", "projectId", "mutationId", "payloadHash", prompt, "sizeSelection", "workflowRevision", "documentRevision", "generationId", "jobData", "contextHash", "expiresAt", "updatedAt") VALUES
      ('request-a', 'workspace-a', 'fixture-user', 'project-a', 'generation-mutation', 'fixture', 'fixture', '{}', 1, 1, 'generation-a', '{}', 'fixture', CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP);
    INSERT INTO "StudioGenerationOutput" (id, "requestId", "workspaceId", "projectId", "widthHint", "heightHint", params, index, "expiresAt") VALUES
      ('output-a', 'request-a', 'workspace-a', 'project-a', 32, 32, '{}', 0, CURRENT_TIMESTAMP + INTERVAL '1 hour');
    INSERT INTO "StudioGeneratedMaterial" ("outputId", "requestId", "workspaceId", "projectId", "userId", "objectKey", "expiresAt", "updatedAt") VALUES
      ('output-a', 'request-a', 'workspace-a', 'project-a', 'fixture-user', 'workspace-a/generated.png', CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP);
    INSERT INTO "StudioDecompositionRequest" (id, "workspaceId", "userId", "projectId", "mutationId", "payloadHash", "sourceShapeId", "assetId", "assetSha256", "documentRevision", "layerCount", "sourceWidth", "sourceHeight", "sourceObjectKey", "sourceMimeType", "sourceSizeBytes", "objectKeys", "expiresAt", "updatedAt") VALUES
      ('decomposition-a', 'workspace-a', 'fixture-user', 'project-a', '00000000-0000-4000-8000-000000000001', 'fixture', 'shape-a', 'asset-a', '${"a".repeat(64)}', 1, 2, 32, 32, 'workspace-a/source.png', 'image/png', 32, '["workspace-a/layer.png"]', CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP);
    INSERT INTO "UsageLog" (id, "workspaceId", kind, status) VALUES ('usage-a', 'workspace-a', 'GENERATE', 'SUCCEEDED');
    INSERT INTO "StudioBrandCreation" (id, "userId", "mutationId", "inputDigest", "workspaceId") VALUES
      ('creation-a', 'fixture-user', '00000000-0000-4000-8000-000000000002', '${"a".repeat(64)}', 'workspace-a');
  `);

  // Refuse to migrate orphan rows; the migration is atomic and never repairs.
  await database.exec(`UPDATE "StudioGeneratedMaterial" SET "workspaceId" = 'missing-workspace' WHERE "outputId" = 'output-a'`);
  let snapshot = await audit();
  check(snapshot.orphans.StudioGeneratedMaterial === 1, "Audit detects orphan in the last newly constrained table");
  await expectSqlError(applyCandidate, "P0001", "Scope guard blocks orphan child linked to another workspace");
  check(await count("StudioGeneratedMaterial") === 1, "Failed migration preserves orphan row");
  await database.exec(`UPDATE "StudioGeneratedMaterial" SET "workspaceId" = 'workspace-a' WHERE "outputId" = 'output-a'; UPDATE "Membership" SET "workspaceId" = 'missing-workspace' WHERE id = 'membership-a'`);
  snapshot = await audit();
  check(snapshot.orphans.Membership === 1, "Audit detects membership orphan with no extra scope relationship");
  await expectSqlError(applyCandidate, "23503", "Validating FK blocks existing membership orphan");
  check((await database.query(`SELECT count(*) AS n FROM pg_constraint WHERE conname = 'Generation_workspaceId_fkey'`)).rows[0].n === 0, "Failed migration is rolled back without partial FKs");
  await database.exec(`UPDATE "Membership" SET "workspaceId" = 'workspace-a' WHERE id = 'membership-a'`);

  // A real but wrong tenant is as dangerous as an orphan: guard each cascade path.
  const scopedTables = [
    ["Generation", "id = 'generation-a'", "Generation.projectId"],
    ["StudioBrandMaterialReceipt", "\"assetId\" = 'asset-a'", "StudioBrandMaterialReceipt.assetId"],
    ["StudioGenerationRequest", "id = 'request-a'", "StudioGenerationRequest.generationId"],
    ["StudioGenerationOutput", "id = 'output-a'", "StudioGenerationOutput.requestId"],
    ["StudioGeneratedMaterial", "\"outputId\" = 'output-a'", "StudioGeneratedMaterial.outputId"],
  ];
  for (const [table, where, path] of scopedTables) {
    await database.exec(`UPDATE "${table}" SET "workspaceId" = 'workspace-b' WHERE ${where}`);
    check((await audit()).mismatches[path] === 1, `Audit detects ${path} cross-tenant relationship`);
    await expectSqlError(applyCandidate, "P0001", `Migration rejects ${path} scope mismatch`);
    await database.exec(`UPDATE "${table}" SET "workspaceId" = 'workspace-a' WHERE ${where}`);
  }
  snapshot = await audit();
  check(Object.values(snapshot.orphans).every((value) => value === 0), "Synthetic fixture is orphan-free before migration");
  check(Object.values(snapshot.mismatches).every((value) => value === 0), "Synthetic fixture has matching tenant scopes before migration");
  await applyCandidate();

  const constrainedTables = ["Membership", "Generation", "StudioBrandMaterialReceipt", "StudioGenerationRequest", "StudioGenerationOutput", "StudioGeneratedMaterial"];
  for (const table of constrainedTables) {
    const { rows } = await database.query("SELECT confdeltype, confupdtype, convalidated FROM pg_constraint WHERE conname = $1", [`${table}_workspaceId_fkey`]);
    check(rows.length === 1 && rows[0].confdeltype === "c" && rows[0].confupdtype === "c" && rows[0].convalidated, `${table}: validated workspace cascade FK`);
    await expectSqlError(() => database.exec(`UPDATE "${table}" SET "workspaceId" = 'missing-workspace' WHERE "workspaceId" = 'workspace-a'`), "23503", `${table}: rejects future orphan writes`);
  }
  const expectedIndexes = ["AsyncTask_refId_idx", "GenerationVersion_parentVersionId_idx", "StudioConversation_projectId_idx", "StudioConversation_userId_idx", "WorkbenchChatDraft_projectId_idx", "Asset_replacementAssetId_idx", "StudioGenerationOutput_workspaceId_idx"];
  const indexNames = new Set((await database.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")).rows.map((row) => row.indexname));
  for (const name of expectedIndexes) check(indexNames.has(name), `Index exists: ${name}`);

  await database.exec(`DELETE FROM "BrandWorkspace" WHERE id = 'workspace-a'`);
  for (const table of constrainedTables) check(await count(table, `"workspaceId" = 'workspace-a'`) === 0, `${table}: brand-owned records cascade after brand deletion`);
  check(await count("Project", `id = 'project-a'`) === 0, "Existing project cascade remains functional");
  check(await count("Asset", `id = 'asset-a'`) === 0, "Existing asset cascade remains functional");
  for (const table of ["BrandWorkspace", "Project", "Membership", "Generation"]) {
    const column = table === "BrandWorkspace" ? "id" : "workspaceId";
    check(await count(table, `"${column}" = 'workspace-b'`) === 1, `${table}: second tenant remains intact`);
  }
  check(await count("AsyncTask", `id = 'upload-a'`) === 1, "Upload task retains its cleanup ownership identity");
  check(await count("StudioMaterialUpload", `"objectKey" = 'workspace-a/pending.png'`) === 1, "Upload object cleanup marker survives brand deletion");
  check(await count("StudioDecompositionRequest", `"objectKeys" = '["workspace-a/layer.png"]'::jsonb`) === 1, "Decomposition object cleanup marker survives brand deletion");
  check(await count("UsageLog", `id = 'usage-a'`) === 1, "Billing history survives brand deletion");
  check(await count("StudioBrandCreation", `id = 'creation-a' AND "workspaceId" IS NULL`) === 1, "Brand creation tombstone keeps existing SET NULL behavior");
  const afterDelete = await audit();
  check(afterDelete.orphans.AsyncTask === 2 && afterDelete.orphans.StudioMaterialUpload === 1 && afterDelete.orphans.StudioDecompositionRequest === 1 && afterDelete.orphans.UsageLog === 1, "Audit distinguishes retained cleanup/billing identities after deletion");
  console.log(JSON.stringify({
    status: "passed", engine: "PGlite (isolated PostgreSQL WASM; not native-server acceptance)",
    baselineMigrations: migrationNames.length, candidateMigration: candidateName, assertions,
    fixtureBeforeMigration: snapshot, fixtureAfterWorkspaceDeletion: afterDelete,
    actualTargetOrphanCounts: "NOT MEASURED: no real database/configuration was accessed",
    limitations: ["Does not validate Prisma migrate or native PostgreSQL operation", "Workspace FK enforces existence; application authorization still enforces cross-reference tenant equality on future writes", "Cleanup/billing soft references intentionally remain"],
  }, null, 2));
} finally {
  await database.close();
}

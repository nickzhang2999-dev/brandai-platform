"use strict";

// Run against the migrated disposable database, exercising the exact aliases
// still used by old CDS fallback profiles.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createRequire } = require("node:module");
const path = require("node:path");

const requireDb = createRequire(path.resolve(__dirname, "../packages/db/package.json"));
const { PrismaClient } = requireDb("@prisma/client");
const prisma = new PrismaClient();

async function fingerprint() {
  const hash = createHash("sha256");
  for (const table of ["Plan", "User", "BrandWorkspace", "ComplianceTerm"]) {
    // xmin detects a rewrite even when all the column values stay identical.
    const rows = await prisma.$queryRawUnsafe(
      `SELECT xmin::text, row_to_json(row) AS value FROM "${table}" AS row ORDER BY id`,
    );
    hash.update(JSON.stringify(rows));
  }
  return hash.digest("hex");
}

async function main() {
  const before = await fingerprint();
  const env = { ...process.env, CDS_PROJECT_ID: "disposable-ci-check" };
  const migration = execFileSync("pnpm", ["db:push"], { env, encoding: "utf8" });
  assert.match(migration, /No pending migrations to apply/);
  const seed = execFileSync("pnpm", ["db:seed"], { env, encoding: "utf8" });
  assert.match(seed, /Deployment detected; skipped local demo data/);
  assert.equal(await fingerprint(), before, "Deployment changed account, plan or demo-related data");
  console.log("PASS: CDS fallback applies pending migrations only and skips seed writes.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());

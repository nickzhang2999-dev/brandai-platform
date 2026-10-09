import type { Prisma } from "@brandai/db";

/** Keep upload (1) and generation (2) capacity checks serialized until commit. */
export async function lockStudioIntake(db: Pick<Prisma.TransactionClient, "$queryRaw">, lane: 1 | 2) {
  // PostgreSQL's lock function returns void, which Prisma cannot deserialize.
  // Cast only the result; the same two-int transaction lock still does the work.
  await db.$queryRaw`SELECT pg_advisory_xact_lock(20261009, ${lane}::integer)::text`;
}

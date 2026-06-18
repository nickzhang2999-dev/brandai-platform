-- G6 团队协作 + 审批流.

-- 1) Version approval workflow fields.
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED');

ALTER TABLE "GenerationVersion"
  ADD COLUMN "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewNote" TEXT;

-- 2) Backfill an OWNER Membership for every existing workspace's owner, so the
--    new member-aware access gate treats current owners as members. Idempotent.
INSERT INTO "Membership" ("id", "userId", "workspaceId", "role", "createdAt")
SELECT 'mbr_' || replace(gen_random_uuid()::text, '-', ''), w."ownerId", w."id", 'OWNER', now()
FROM "BrandWorkspace" w
WHERE NOT EXISTS (
  SELECT 1 FROM "Membership" m
  WHERE m."userId" = w."ownerId" AND m."workspaceId" = w."id"
);

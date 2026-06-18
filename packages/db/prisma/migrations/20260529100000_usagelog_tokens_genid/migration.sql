-- 2026-05-29 — activity-log v2: per-request token count + a soft generationId
-- reference (no FK, audit-survives-deletion) for the log's image thumbnail.
ALTER TABLE "UsageLog" ADD COLUMN "totalTokens" INTEGER;
ALTER TABLE "UsageLog" ADD COLUMN "generationId" TEXT;

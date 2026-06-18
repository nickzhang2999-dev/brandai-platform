-- 2026-05-29 — Wall-clock timing for Generation, driving the live queue
-- widget + activity log per docs/PRINCIPLES.md §2. All nullable: existing
-- rows pre-date the worker's timing writes and need no backfill.
ALTER TABLE "Generation" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "Generation" ADD COLUMN "finishedAt" TIMESTAMP(3);
ALTER TABLE "Generation" ADD COLUMN "durationMs" INTEGER;

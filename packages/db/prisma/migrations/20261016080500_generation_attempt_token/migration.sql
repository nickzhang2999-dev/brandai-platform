-- Local schema preparation only. Existing queued jobs lack an attempt identity
-- and must be explicitly resubmitted instead of replayed against a new attempt.
ALTER TABLE "Generation" ADD COLUMN "attemptToken" TEXT;

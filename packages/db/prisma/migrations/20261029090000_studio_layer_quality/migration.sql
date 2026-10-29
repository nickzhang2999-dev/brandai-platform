-- Null means not checked. Never backfill historical layers from an HTTP read.
ALTER TABLE "StudioDecompositionRequest" ADD COLUMN "qualityJson" JSONB;

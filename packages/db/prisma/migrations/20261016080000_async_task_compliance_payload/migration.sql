-- Local schema preparation only. Apply through an approved environment migration.
ALTER TABLE "AsyncTask"
  ADD COLUMN "inputJson" JSONB,
  ADD COLUMN "resultJson" JSONB;

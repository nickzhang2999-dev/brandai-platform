ALTER TABLE "DeepFlareWorkOrderDispatch"
  ADD COLUMN "actorId" TEXT,
  ADD COLUMN "executionKey" TEXT,
  ADD COLUMN "workflowRevision" INTEGER,
  ADD COLUMN "documentRevision" INTEGER,
  ADD COLUMN "nativeRequestId" TEXT,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "failureCode" TEXT;
CREATE UNIQUE INDEX "DeepFlareWorkOrderDispatch_executionKey_key" ON "DeepFlareWorkOrderDispatch"("executionKey");
CREATE UNIQUE INDEX "DeepFlareWorkOrderDispatch_nativeRequestId_key" ON "DeepFlareWorkOrderDispatch"("nativeRequestId");

CREATE TABLE "StudioMaterialUpload" (
  "taskId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "mutationId" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 10485760),
  "body" BYTEA,
  "width" INTEGER,
  "height" INTEGER,
  "objectKey" TEXT NOT NULL,
  "attemptToken" TEXT,
  "assetId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "objectCleanedAt" TIMESTAMP(3),
  CONSTRAINT "StudioMaterialUpload_pkey" PRIMARY KEY ("taskId"),
  CONSTRAINT "StudioMaterialUpload_body_bound" CHECK ("body" IS NULL OR octet_length("body") = "sizeBytes"),
  CONSTRAINT "StudioMaterialUpload_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AsyncTask"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StudioMaterialUpload_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StudioMaterialUpload_assetId_key" ON "StudioMaterialUpload"("assetId");
CREATE UNIQUE INDEX "StudioMaterialUpload_workspaceId_userId_projectId_mutationId_key" ON "StudioMaterialUpload"("workspaceId", "userId", "projectId", "mutationId");
CREATE INDEX "StudioMaterialUpload_workspaceId_projectId_createdAt_idx" ON "StudioMaterialUpload"("workspaceId", "projectId", "createdAt");
CREATE INDEX "StudioMaterialUpload_expiresAt_idx" ON "StudioMaterialUpload"("expiresAt");

ALTER TABLE "WorkbenchProjectState"
  ADD COLUMN "workflowRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "workflowMode" TEXT NOT NULL DEFAULT 'generate',
  ADD COLUMN "workflowTarget" JSONB,
  ADD COLUMN "workflowReferences" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "workflowUpdatedAt" TIMESTAMP(3);

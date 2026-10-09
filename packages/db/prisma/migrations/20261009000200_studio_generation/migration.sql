CREATE TABLE "StudioGenerationRequest" (
 "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "userId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
 "mutationId" TEXT NOT NULL, "payloadHash" TEXT NOT NULL, "prompt" TEXT NOT NULL, "sizeSelection" JSONB NOT NULL,
 "workflowRevision" INTEGER NOT NULL, "documentRevision" INTEGER NOT NULL, "generationId" TEXT NOT NULL,
 "jobData" JSONB NOT NULL, "contextHash" TEXT NOT NULL, "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
 "providerStartedAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3) NOT NULL, "error" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "StudioGenerationRequest_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "Generation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StudioGenerationRequest_generationId_key" ON "StudioGenerationRequest"("generationId");
CREATE UNIQUE INDEX "StudioGenerationRequest_identity_key" ON "StudioGenerationRequest"("workspaceId", "userId", "projectId", "mutationId");
CREATE INDEX "StudioGenerationRequest_history_idx" ON "StudioGenerationRequest"("workspaceId", "userId", "projectId", "createdAt");
CREATE INDEX "StudioGenerationRequest_status_expiresAt_idx" ON "StudioGenerationRequest"("status", "expiresAt");

CREATE TABLE "StudioGenerationOutput" (
 "id" TEXT PRIMARY KEY, "requestId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "projectId" TEXT NOT NULL,
 "imageUrl" TEXT, "widthHint" INTEGER NOT NULL, "heightHint" INTEGER NOT NULL, "params" JSONB NOT NULL, "index" INTEGER NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "StudioGenerationOutput_source_bound" CHECK ("imageUrl" IS NULL OR octet_length("imageUrl") <= 50331648),
 CONSTRAINT "StudioGenerationOutput_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "StudioGenerationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StudioGenerationOutput_requestId_index_key" ON "StudioGenerationOutput"("requestId", "index");
CREATE INDEX "StudioGenerationOutput_expiresAt_idx" ON "StudioGenerationOutput"("expiresAt");

CREATE TABLE "StudioGeneratedMaterial" (
 "outputId" TEXT PRIMARY KEY, "versionId" TEXT, "requestId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "projectId" TEXT NOT NULL, "userId" TEXT NOT NULL,
 "status" "JobStatus" NOT NULL DEFAULT 'PENDING', "objectKey" TEXT NOT NULL, "attemptToken" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0,
 "expiresAt" TIMESTAMP(3) NOT NULL, "startedAt" TIMESTAMP(3), "sha256" TEXT, "mimeType" TEXT, "sizeBytes" INTEGER,
 "width" INTEGER, "height" INTEGER, "assetId" TEXT, "error" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "StudioGeneratedMaterial_outputId_fkey" FOREIGN KEY ("outputId") REFERENCES "StudioGenerationOutput"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "StudioGeneratedMaterial_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "GenerationVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE,
 CONSTRAINT "StudioGeneratedMaterial_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "StudioGenerationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "StudioGeneratedMaterial_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StudioGeneratedMaterial_versionId_key" ON "StudioGeneratedMaterial"("versionId");
CREATE UNIQUE INDEX "StudioGeneratedMaterial_assetId_key" ON "StudioGeneratedMaterial"("assetId");
CREATE INDEX "StudioGeneratedMaterial_status_expiresAt_idx" ON "StudioGeneratedMaterial"("status", "expiresAt");
CREATE INDEX "StudioGeneratedMaterial_workspaceId_projectId_status_idx" ON "StudioGeneratedMaterial"("workspaceId", "projectId", "status");
CREATE INDEX "StudioGeneratedMaterial_requestId_idx" ON "StudioGeneratedMaterial"("requestId");

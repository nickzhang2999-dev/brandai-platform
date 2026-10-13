-- Durable decomposition requests retain their paid-provider claim and private
-- stage after HTTP/queue failures. Additive only; no existing data is changed.
CREATE TABLE "StudioDecompositionRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "mutationId" UUID NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "sourceShapeId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "assetSha256" TEXT NOT NULL,
    "documentRevision" INTEGER NOT NULL,
    "layerCount" INTEGER NOT NULL,
    "intent" TEXT,
    "sourceWidth" INTEGER NOT NULL,
    "sourceHeight" INTEGER NOT NULL,
    "sourceObjectKey" TEXT NOT NULL,
    "sourceMimeType" TEXT NOT NULL,
    "sourceSizeBytes" INTEGER NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "providerStartedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "archiveExpiresAt" TIMESTAMP(3),
    "outputJson" JSONB,
    "publishedLayers" JSONB NOT NULL DEFAULT '[]',
    "objectKeys" JSONB NOT NULL DEFAULT '[]',
    "archiveToken" TEXT,
    "archivingStartedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StudioDecompositionRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StudioDecompositionRequest_identity_key"
    ON "StudioDecompositionRequest"("workspaceId", "userId", "projectId", "mutationId");
CREATE INDEX "StudioDecompositionRequest_history_idx"
    ON "StudioDecompositionRequest"("workspaceId", "projectId", "createdAt");
CREATE INDEX "StudioDecompositionRequest_status_expiresAt_idx"
    ON "StudioDecompositionRequest"("status", "expiresAt");

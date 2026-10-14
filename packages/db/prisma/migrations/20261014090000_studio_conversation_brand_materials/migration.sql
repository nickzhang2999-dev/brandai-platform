ALTER TABLE "StudioMaterialUpload" ADD COLUMN "attachToProject" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "StudioConversation" (
  "id" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "projectId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "draft" JSONB, "draftRevision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudioConversation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StudioConversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StudioConversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StudioConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StudioConversation_draftRevision_check" CHECK ("draftRevision" >= 0)
);
CREATE UNIQUE INDEX "StudioConversation_workspaceId_userId_projectId_key" ON "StudioConversation"("workspaceId", "userId", "projectId");

CREATE TABLE "StudioConversationMessage" (
  "id" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "mutationId" UUID NOT NULL, "payloadHash" CHAR(64) NOT NULL,
  "text" TEXT NOT NULL, "references" JSONB NOT NULL, "input" JSONB NOT NULL, "acceptedCanvas" TEXT NOT NULL,
  "intent" JSONB, "status" TEXT NOT NULL DEFAULT 'PENDING', "generationRequestId" TEXT,
  "attemptToken" TEXT, "startedAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3) NOT NULL, "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudioConversationMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StudioConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "StudioConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StudioConversationMessage_status_check" CHECK ("status" IN ('PENDING','RUNNING','CLARIFICATION','SUCCEEDED','FAILED')),
  CONSTRAINT "StudioConversationMessage_payloadHash_check" CHECK ("payloadHash" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "StudioConversationMessage_conversationId_mutationId_key" ON "StudioConversationMessage"("conversationId", "mutationId");
CREATE UNIQUE INDEX "StudioConversationMessage_generationRequestId_key" ON "StudioConversationMessage"("generationRequestId");
CREATE INDEX "StudioConversationMessage_conversationId_createdAt_id_idx" ON "StudioConversationMessage"("conversationId", "createdAt", "id");
CREATE INDEX "StudioConversationMessage_status_expiresAt_idx" ON "StudioConversationMessage"("status", "expiresAt");

CREATE TABLE "StudioBrandMaterialReceipt" (
  "assetId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL, "userId" TEXT NOT NULL, "taskId" TEXT NOT NULL,
  "sha256" TEXT, "mimeType" TEXT NOT NULL, "sizeBytes" INTEGER NOT NULL, "width" INTEGER, "height" INTEGER,
  "sourceDigest" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "attemptToken" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StudioBrandMaterialReceipt_pkey" PRIMARY KEY ("assetId"),
  CONSTRAINT "StudioBrandMaterialReceipt_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StudioBrandMaterialReceipt_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AsyncTask"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "StudioBrandMaterialReceipt_taskId_key" ON "StudioBrandMaterialReceipt"("taskId");
CREATE INDEX "StudioBrandMaterialReceipt_workspaceId_idx" ON "StudioBrandMaterialReceipt"("workspaceId");
CREATE INDEX "StudioBrandMaterialReceipt_expiresAt_idx" ON "StudioBrandMaterialReceipt"("expiresAt");

CREATE TABLE "StudioWritingDocument" (
 "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE,
 "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE,
 "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
 "title" TEXT NOT NULL DEFAULT '未命名文案', "text" TEXT NOT NULL DEFAULT '', "revision" INTEGER NOT NULL DEFAULT 0,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "StudioWritingDocument_workspaceId_projectId_userId_key" UNIQUE ("workspaceId","projectId","userId")
);
CREATE INDEX "StudioWritingDocument_userId_updatedAt_idx" ON "StudioWritingDocument"("userId","updatedAt");
CREATE TABLE "StudioWritingVersion" (
 "id" TEXT PRIMARY KEY, "documentId" TEXT NOT NULL REFERENCES "StudioWritingDocument"("id") ON DELETE CASCADE,
 "revision" INTEGER NOT NULL, "mutationId" UUID NOT NULL, "payloadHash" CHAR(64) NOT NULL,
 "title" TEXT NOT NULL, "text" TEXT NOT NULL, "operation" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "StudioWritingVersion_documentId_revision_key" UNIQUE ("documentId","revision"),
 CONSTRAINT "StudioWritingVersion_documentId_mutationId_key" UNIQUE ("documentId","mutationId")
);
CREATE TABLE "StudioWritingReference" (
 "id" TEXT PRIMARY KEY, "documentId" TEXT NOT NULL REFERENCES "StudioWritingDocument"("id") ON DELETE CASCADE,
 "mutationId" UUID NOT NULL, "payloadHash" CHAR(64) NOT NULL, "taskId" TEXT NOT NULL UNIQUE,
 "name" TEXT NOT NULL, "mimeType" TEXT NOT NULL, "sha256" CHAR(64) NOT NULL, "sizeBytes" INTEGER NOT NULL,
 "kind" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'PENDING', "error" TEXT, "body" BYTEA, "assetId" TEXT,
 "segments" JSONB NOT NULL DEFAULT '[]', "deletedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "StudioWritingReference_documentId_mutationId_key" UNIQUE ("documentId","mutationId")
);
CREATE INDEX "StudioWritingReference_documentId_deletedAt_createdAt_idx" ON "StudioWritingReference"("documentId","deletedAt","createdAt");
CREATE TABLE "StudioWritingMessage" (
 "id" TEXT PRIMARY KEY, "documentId" TEXT NOT NULL REFERENCES "StudioWritingDocument"("id") ON DELETE CASCADE,
 "taskId" TEXT NOT NULL, "role" TEXT NOT NULL, "text" TEXT NOT NULL, "citations" JSONB NOT NULL DEFAULT '[]',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "StudioWritingMessage_taskId_role_key" UNIQUE ("taskId","role")
);
CREATE INDEX "StudioWritingMessage_documentId_createdAt_id_idx" ON "StudioWritingMessage"("documentId","createdAt","id");
CREATE TABLE "StudioWritingStyle" (
 "workspaceId" TEXT PRIMARY KEY REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE,
 "revision" INTEGER NOT NULL DEFAULT 0, "rules" JSONB NOT NULL DEFAULT '[]', "examples" JSONB NOT NULL DEFAULT '[]', "confirmedAt" TIMESTAMP(3)
);
CREATE TABLE "StudioWritingStyleVersion" (
 "id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL REFERENCES "StudioWritingStyle"("workspaceId") ON DELETE CASCADE,
 "revision" INTEGER NOT NULL, "userId" TEXT NOT NULL, "mutationId" UUID NOT NULL, "payloadHash" CHAR(64) NOT NULL,
 "rules" JSONB NOT NULL, "examples" JSONB NOT NULL, "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "StudioWritingStyleVersion_workspaceId_revision_key" UNIQUE ("workspaceId","revision"),
 CONSTRAINT "StudioWritingStyleVersion_workspaceId_userId_mutationId_key" UNIQUE ("workspaceId","userId","mutationId")
);

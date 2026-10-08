CREATE TABLE "WorkbenchBrandDraft" (
  "workspaceId" TEXT NOT NULL PRIMARY KEY,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "colors" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "font" TEXT NOT NULL DEFAULT 'system',
  "notes" TEXT NOT NULL DEFAULT '',
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkbenchBrandDraft_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "WorkbenchUserState" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "profile" JSONB NOT NULL,
  "favorites" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkbenchUserState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkbenchUserState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkbenchUserState_userId_workspaceId_key" ON "WorkbenchUserState"("userId", "workspaceId");
CREATE TABLE "WorkbenchProjectState" (
  "projectId" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "brief" TEXT NOT NULL DEFAULT '',
  "notes" TEXT NOT NULL DEFAULT '',
  "archiveRevision" INTEGER NOT NULL DEFAULT 0,
  "creationKey" TEXT,
  "creationChecksum" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkbenchProjectState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkbenchProjectState_creationKey_key" ON "WorkbenchProjectState"("creationKey");
CREATE INDEX "WorkbenchProjectState_workspaceId_idx" ON "WorkbenchProjectState"("workspaceId");
CREATE TABLE "WorkbenchChatDraft" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "inputForm" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkbenchChatDraft_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkbenchChatDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "WorkbenchChatDraft_userId_projectId_key" ON "WorkbenchChatDraft"("userId", "projectId");

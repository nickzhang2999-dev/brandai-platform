-- Independent receipts remain after imported rules are edited or deleted.
-- Additive only: no existing brand knowledge, accounts or settings are changed.
CREATE TABLE "WorkbenchKnowledgeImport" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mutationId" TEXT NOT NULL,
    "draftRevision" INTEGER NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "source" JSONB NOT NULL,
    "receipt" JSONB NOT NULL,
    "ruleIds" JSONB NOT NULL,
    "ruleCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkbenchKnowledgeImport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkbenchKnowledgeImport_scope_key" ON "WorkbenchKnowledgeImport"("workspaceId", "userId", "mutationId");
CREATE INDEX "WorkbenchKnowledgeImport_workspaceId_createdAt_idx" ON "WorkbenchKnowledgeImport"("workspaceId", "createdAt");

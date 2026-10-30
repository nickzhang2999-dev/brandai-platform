ALTER TABLE "WorkbenchProjectState"
  ADD COLUMN "contextRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "contextJson" JSONB,
  ADD COLUMN "contextUpdatedAt" TIMESTAMP(3);
ALTER TABLE "StudioConversationMessage" ADD COLUMN "projectContextJson" JSONB;
CREATE TABLE "StudioProjectContextMutation" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "mutationId" UUID NOT NULL,
  "payloadHash" CHAR(64) NOT NULL,
  "revision" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudioProjectContextMutation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StudioProjectContextMutation_identity_key" ON "StudioProjectContextMutation"("workspaceId", "projectId", "userId", "mutationId");
CREATE INDEX "StudioProjectContextMutation_history_idx" ON "StudioProjectContextMutation"("workspaceId", "projectId", "createdAt");
ALTER TABLE "StudioProjectContextMutation" ADD CONSTRAINT "StudioProjectContextMutation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InspirationFeedback" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InspirationFeedback_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InspirationFeedback_revision_check" CHECK ("revision" > 0),
    CONSTRAINT "InspirationFeedback_kind_check" CHECK ("kind" IN ('IRRELEVANT','ANALYSIS_ERROR','UNSUPPORTED_CITATION','BROKEN_IMAGE')),
    CONSTRAINT "InspirationFeedback_status_check" CHECK ("status" IN ('OPEN','RESOLVED')),
    CONSTRAINT "InspirationFeedback_note_check" CHECK (char_length("note") <= 1000)
);
CREATE INDEX "InspirationFeedback_workspaceId_userId_createdAt_idx" ON "InspirationFeedback"("workspaceId", "userId", "createdAt");
CREATE INDEX "InspirationFeedback_workspaceId_status_createdAt_idx" ON "InspirationFeedback"("workspaceId", "status", "createdAt");
ALTER TABLE "InspirationFeedback" ADD CONSTRAINT "InspirationFeedback_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

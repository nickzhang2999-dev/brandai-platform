-- C8 规则版本管理 — immutable snapshot of a workspace's CONFIRMED brand-rule
-- set, for version history + one-click rollback. Additive: new table only.
CREATE TABLE "RuleSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "ruleCount" INTEGER NOT NULL DEFAULT 0,
    "rules" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RuleSnapshot_workspaceId_createdAt_idx"
  ON "RuleSnapshot"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "RuleSnapshot" ADD CONSTRAINT "RuleSnapshot_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

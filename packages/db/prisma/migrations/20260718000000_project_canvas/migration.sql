-- V0.0.13d 工作台画布服务端持久化（纯 additive，共享库安全）
CREATE TABLE IF NOT EXISTS "ProjectCanvas" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "camera" JSONB,
    "removedVersionIds" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectCanvas_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProjectCanvas_projectId_key" ON "ProjectCanvas"("projectId");
CREATE INDEX IF NOT EXISTS "ProjectCanvas_workspaceId_idx" ON "ProjectCanvas"("workspaceId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ProjectCanvas_projectId_fkey'
      AND conrelid = '"ProjectCanvas"'::regclass
  ) THEN
    ALTER TABLE "ProjectCanvas"
      ADD CONSTRAINT "ProjectCanvas_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

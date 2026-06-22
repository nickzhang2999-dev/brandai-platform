-- E11/E12 · ProjectAsset（加入项目 / 设为参考 的服务端真关系）+ P02 Project.archivedAt。
--
-- 幂等写法（IF NOT EXISTS），与既有迁移同风格；加性、向后兼容 —— 共享 CDS Postgres
-- 上不会破坏不认识这些对象的其它分支（新表/新列只被本分支读写）。

-- Project.archivedAt（区分「已归档」与「已完成」，避免改 CampaignStatus 枚举）
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);

-- ProjectAsset 关联表
CREATE TABLE IF NOT EXISTS "ProjectAsset" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'MEMBER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectAsset_pkey" PRIMARY KEY ("id")
);

-- 唯一约束：同一 (project, asset, kind) 只一条
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectAsset_projectId_assetId_kind_key"
  ON "ProjectAsset"("projectId", "assetId", "kind");
CREATE INDEX IF NOT EXISTS "ProjectAsset_projectId_idx" ON "ProjectAsset"("projectId");
CREATE INDEX IF NOT EXISTS "ProjectAsset_assetId_idx" ON "ProjectAsset"("assetId");

-- 外键（onDelete: Cascade）。先查后建，避免重复。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProjectAsset_projectId_fkey') THEN
    ALTER TABLE "ProjectAsset" ADD CONSTRAINT "ProjectAsset_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProjectAsset_assetId_fkey') THEN
    ALTER TABLE "ProjectAsset" ADD CONSTRAINT "ProjectAsset_assetId_fkey"
      FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

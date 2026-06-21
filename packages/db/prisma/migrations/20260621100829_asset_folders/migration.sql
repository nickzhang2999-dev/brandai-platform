-- E3 · 素材文件夹（AssetFolder）+ Asset.folderId。
--
-- 幂等写法（IF NOT EXISTS / DO 块），与 20260619000000_brandai_fields 同风格：
--   · 全新库：建表 + 列 + 外键 + 索引；
--   · 已有这些对象的库：逐条 no-op，不报 “already exists”。

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "AssetFolder" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AssetFolder_pkey" PRIMARY KEY ("id")
);

-- Index on AssetFolder.workspaceId
CREATE INDEX IF NOT EXISTS "AssetFolder_workspaceId_idx" ON "AssetFolder"("workspaceId");

-- Asset.folderId column
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "folderId" TEXT;

-- Index on Asset(workspaceId, folderId)
CREATE INDEX IF NOT EXISTS "Asset_workspaceId_folderId_idx" ON "Asset"("workspaceId", "folderId");

-- FK: AssetFolder.workspaceId → BrandWorkspace.id (CASCADE)
DO $$ BEGIN
  ALTER TABLE "AssetFolder"
    ADD CONSTRAINT "AssetFolder_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- FK: Asset.folderId → AssetFolder.id (SET NULL)
DO $$ BEGIN
  ALTER TABLE "Asset"
    ADD CONSTRAINT "Asset_folderId_fkey"
    FOREIGN KEY ("folderId") REFERENCES "AssetFolder"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

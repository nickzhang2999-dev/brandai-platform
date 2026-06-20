-- BrandAI additive fields for BrandWorkspace / Project / Asset + CampaignStatus enum.
--
-- 这些列/枚举随 schema 一起加入（commit ef618b2），但当时漏建迁移，导致全新库
-- `prisma migrate deploy` 缺列、/api/workspaces 等路由报错（Codex review #1）。
-- 本迁移全部使用幂等写法（IF NOT EXISTS / DO 块），因此：
--   · 全新库：补齐列与枚举；
--   · 已存在这些列的库（线上现网）：逐条 no-op，不会报 “already exists”。

-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- BrandWorkspace：品牌展示/调性属性
ALTER TABLE "BrandWorkspace" ADD COLUMN IF NOT EXISTS "subtitle" TEXT;
ALTER TABLE "BrandWorkspace" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "BrandWorkspace" ADD COLUMN IF NOT EXISTS "coverImage" TEXT;
ALTER TABLE "BrandWorkspace" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "BrandWorkspace" ADD COLUMN IF NOT EXISTS "isVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BrandWorkspace" ADD COLUMN IF NOT EXISTS "positioning" TEXT;
ALTER TABLE "BrandWorkspace" ADD COLUMN IF NOT EXISTS "targetAudience" TEXT;
ALTER TABLE "BrandWorkspace" ADD COLUMN IF NOT EXISTS "slogan" TEXT;

-- Project：Campaign 业务字段
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT';
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "progress" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "coverImage" TEXT;
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "channels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "startDate" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "endDate" TIMESTAMP(3);
ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "aiSummary" TEXT;

-- Asset：素材库智能字段
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "aiTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "aiDescription" TEXT;
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "isFavorite" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "resolution" TEXT;

-- Index (Project workspaceId+status)
CREATE INDEX IF NOT EXISTS "Project_workspaceId_status_idx" ON "Project"("workspaceId", "status");

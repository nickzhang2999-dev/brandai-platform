-- F18 · 出图回流素材库 — Asset.generationVersionId（镜像出图版本的加性可空列）。
--
-- 幂等（IF NOT EXISTS）+ 加性，与既有迁移同风格。共享 CDS Postgres 上不破坏不认识
-- 该列的其它分支：它们的 Prisma client 不 select 该列，NULL 默认也不违反任何约束。
-- **刻意不改 AssetSource 枚举** —— 给共享库枚举加值会让不认识该值的其它分支 Prisma
-- 读 Asset 直接崩（同 ProjectAsset.kind 用 String 而非 enum 的规避）。AI 生成来源由
-- 该列是否存在标识。

ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "generationVersionId" TEXT;

-- 唯一约束：一个出图版本至多镜像一条素材（→ worker 重试 / 回填脚本天然幂等）。
CREATE UNIQUE INDEX IF NOT EXISTS "Asset_generationVersionId_key"
  ON "Asset"("generationVersionId");

-- 外键（onDelete: Cascade）：出图版本被重新生成删除时，其镜像素材随之清理。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Asset_generationVersionId_fkey') THEN
    ALTER TABLE "Asset" ADD CONSTRAINT "Asset_generationVersionId_fkey"
      FOREIGN KEY ("generationVersionId") REFERENCES "GenerationVersion"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- V0.0.9 · 图片三分法 + workspace 水印配置。
ALTER TABLE "Asset"
  ADD COLUMN "libraryKind" TEXT NOT NULL DEFAULT 'MATERIAL';

UPDATE "Asset"
SET "libraryKind" = 'GENERATED'
WHERE "generationVersionId" IS NOT NULL;

CREATE INDEX "Asset_workspaceId_libraryKind_idx" ON "Asset"("workspaceId", "libraryKind");

CREATE TABLE "WatermarkPreset" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT '默认水印',
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "config" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WatermarkPreset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WatermarkPreset_workspaceId_idx" ON "WatermarkPreset"("workspaceId");
CREATE INDEX "WatermarkPreset_workspaceId_isActive_idx" ON "WatermarkPreset"("workspaceId", "isActive");

ALTER TABLE "WatermarkPreset"
  ADD CONSTRAINT "WatermarkPreset_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

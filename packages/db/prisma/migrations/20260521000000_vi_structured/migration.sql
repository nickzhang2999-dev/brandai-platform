-- P1.1 + P1.3 — VI strong-typed structured payload, asset availability,
-- ProhibitionRule independent table. Non-destructive: existing BrandRule.value
-- and Asset rows are preserved as-is.

-- CreateEnum
CREATE TYPE "ProhibitionSeverity" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "ProhibitionStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING');

-- AlterTable
ALTER TABLE "BrandRule" ADD COLUMN "structured" JSONB;

-- AlterTable
ALTER TABLE "Asset"
  ADD COLUMN "availableForGeneration" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "deprecatedAt" TIMESTAMP(3),
  ADD COLUMN "replacementAssetId" TEXT;

-- CreateIndex
CREATE INDEX "Asset_workspaceId_availableForGeneration_idx"
  ON "Asset"("workspaceId", "availableForGeneration");

-- AddForeignKey (asset → asset self-reference)
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_replacementAssetId_fkey"
  FOREIGN KEY ("replacementAssetId") REFERENCES "Asset"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ProhibitionRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "severity" "ProhibitionSeverity" NOT NULL,
    "affectsGeneration" BOOLEAN NOT NULL DEFAULT true,
    "affectsValidation" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT NOT NULL,
    "scope" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "positiveExampleAssetId" TEXT,
    "negativeExampleAssetId" TEXT,
    "alternativeSuggestion" TEXT,
    "applicableChannels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ProhibitionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProhibitionRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProhibitionRule_workspaceId_status_idx"
  ON "ProhibitionRule"("workspaceId", "status");

-- AddForeignKey
ALTER TABLE "ProhibitionRule" ADD CONSTRAINT "ProhibitionRule_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProhibitionRule" ADD CONSTRAINT "ProhibitionRule_positiveExampleAssetId_fkey"
  FOREIGN KEY ("positiveExampleAssetId") REFERENCES "Asset"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProhibitionRule" ADD CONSTRAINT "ProhibitionRule_negativeExampleAssetId_fkey"
  FOREIGN KEY ("negativeExampleAssetId") REFERENCES "Asset"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

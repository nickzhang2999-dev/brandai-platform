-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AssetCategory" AS ENUM ('LOGO', 'PRODUCT', 'PACKAGING', 'KV', 'ECOM', 'SOCIAL', 'VI_DOC', 'OTHER');

-- CreateEnum
CREATE TYPE "AssetSource" AS ENUM ('UPLOAD', 'WEBSITE');

-- CreateEnum
CREATE TYPE "RuleType" AS ENUM ('color', 'font', 'layout', 'imagery', 'graphic', 'copy', 'logo');

-- CreateEnum
CREATE TYPE "RuleStrength" AS ENUM ('STRONG', 'WEAK', 'FORBIDDEN');

-- CreateEnum
CREATE TYPE "RuleStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ComplianceTermType" AS ENUM ('FORBIDDEN', 'CAUTION');

-- CreateEnum
CREATE TYPE "SceneType" AS ENUM ('ECOM_MAIN', 'SCENE', 'SOCIAL_POSTER', 'CAMPAIGN_KV', 'SELLING_POINT');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandWorkspace" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "industry" TEXT,
    "websiteUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "category" "AssetCategory" NOT NULL,
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "source" "AssetSource" NOT NULL DEFAULT 'UPLOAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "RuleType" NOT NULL,
    "strength" "RuleStrength" NOT NULL DEFAULT 'WEAK',
    "status" "RuleStatus" NOT NULL DEFAULT 'DRAFT',
    "summary" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceTerm" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "ComplianceTermType" NOT NULL,
    "term" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "replacement" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComplianceTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "campaign" TEXT,
    "product" TEXT,
    "channel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Generation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sceneType" "SceneType" NOT NULL,
    "sellingPoint" TEXT NOT NULL,
    "scene" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Generation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationVersion" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "index" INTEGER NOT NULL DEFAULT 0,
    "imageUrl" TEXT NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 1024,
    "height" INTEGER NOT NULL DEFAULT 1024,
    "params" JSONB NOT NULL DEFAULT '{}',
    "complianceReport" JSONB,
    "parentVersionId" TEXT,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "BrandWorkspace_ownerId_idx" ON "BrandWorkspace"("ownerId");

-- CreateIndex
CREATE INDEX "Asset_workspaceId_category_idx" ON "Asset"("workspaceId", "category");

-- CreateIndex
CREATE INDEX "BrandRule_workspaceId_status_idx" ON "BrandRule"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "ComplianceTerm_workspaceId_type_idx" ON "ComplianceTerm"("workspaceId", "type");

-- CreateIndex
CREATE INDEX "Project_workspaceId_idx" ON "Project"("workspaceId");

-- CreateIndex
CREATE INDEX "Generation_projectId_idx" ON "Generation"("projectId");

-- CreateIndex
CREATE INDEX "GenerationVersion_generationId_idx" ON "GenerationVersion"("generationId");

-- AddForeignKey
ALTER TABLE "BrandWorkspace" ADD CONSTRAINT "BrandWorkspace_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandRule" ADD CONSTRAINT "BrandRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceTerm" ADD CONSTRAINT "ComplianceTerm_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "BrandWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationVersion" ADD CONSTRAINT "GenerationVersion_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "Generation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


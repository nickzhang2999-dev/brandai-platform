-- M-D — subscription tiers (D5) + per-user quota/rate-limit support (D4).
-- Additive only: no existing rows are modified. Users with no Subscription
-- row are treated as STARTER by lib/quota.ts, so this migration is safe to
-- deploy ahead of any billing integration.

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('STARTER', 'PRO', 'TEAM', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'CANCELED', 'PAST_DUE');

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "tier" "PlanTier" NOT NULL,
    "name" TEXT NOT NULL,
    "priceCentsMonthly" INTEGER NOT NULL DEFAULT 0,
    "monthlyGenerationQuota" INTEGER NOT NULL DEFAULT -1,
    "dailyGenerationLimit" INTEGER NOT NULL DEFAULT -1,
    "maxWorkspaces" INTEGER NOT NULL DEFAULT -1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_tier_key" ON "Plan"("tier");

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentPeriodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- CreateIndex
CREATE INDEX "Subscription_planId_idx" ON "Subscription"("planId");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "Plan"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex (per-user/period quota scan)
CREATE INDEX "Generation_workspaceId_createdAt_idx"
  ON "Generation"("workspaceId", "createdAt");

-- Seed the 4 SaaS tiers (I5–I8). Reference data, so it lives in the migration
-- to guarantee presence in every environment. -1 = unlimited. Quota numbers
-- are sane defaults pending [Collab] per-tier confirmation; safe to UPDATE
-- later. ON CONFLICT keeps re-deploys idempotent.
INSERT INTO "Plan" ("id","tier","name","priceCentsMonthly","monthlyGenerationQuota","dailyGenerationLimit","maxWorkspaces")
VALUES
  ('plan_starter','STARTER','Starter',0,20,5,1),
  ('plan_pro','PRO','Pro',2900,300,50,3),
  ('plan_team','TEAM','Team',9900,1500,200,10),
  ('plan_enterprise','ENTERPRISE','Enterprise',0,-1,-1,-1)
ON CONFLICT ("tier") DO NOTHING;

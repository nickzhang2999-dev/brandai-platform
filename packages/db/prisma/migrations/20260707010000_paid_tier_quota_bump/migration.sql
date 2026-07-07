-- Preserve tier ordering after the STARTER bump. The previous migration raised
-- STARTER to 30/day · 600/month, which would have left the PAID PRO tier
-- (50/day · 300/month) with a SMALLER monthly quota than the free default —
-- resolvePlan hands an ACTIVE PRO subscriber their plan, so they'd be capped at
-- 300/month while an unsubscribed STARTER user gets 600. Bump PRO/TEAM so the
-- ordering STARTER < PRO < TEAM < ENTERPRISE holds on BOTH daily and monthly.
--
-- Each row is guarded to its ORIGINAL seeded values so this is a no-op once an
-- operator has customized a tier via /admin/plans — a one-time migration must
-- never clobber a deliberate value.
UPDATE "Plan"
SET "dailyGenerationLimit" = 100,
    "monthlyGenerationQuota" = 3000
WHERE "tier" = 'PRO'
  AND "dailyGenerationLimit" = 50
  AND "monthlyGenerationQuota" = 300;

UPDATE "Plan"
SET "dailyGenerationLimit" = 400,
    "monthlyGenerationQuota" = 12000
WHERE "tier" = 'TEAM'
  AND "dailyGenerationLimit" = 200
  AND "monthlyGenerationQuota" = 1500;

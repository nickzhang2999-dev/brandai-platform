-- Raise the STARTER (default) tier's generation quota so designers on the free
-- default tier aren't capped at 5/day. Users without an active Subscription
-- resolve to STARTER (lib/quota.ts#resolvePlan), so this bumps the effective
-- default for everyone at once. Admins can further tune it in /admin/plans.
--
-- Guarded to the ORIGINAL seeded defaults (5/day, 20/month) so it is a no-op if
-- an operator has already customized the STARTER row via the admin panel — a
-- one-time migration must never clobber a deliberate value.
UPDATE "Plan"
SET "dailyGenerationLimit" = 30,
    "monthlyGenerationQuota" = 600
WHERE "tier" = 'STARTER'
  AND "dailyGenerationLimit" = 5
  AND "monthlyGenerationQuota" = 20;

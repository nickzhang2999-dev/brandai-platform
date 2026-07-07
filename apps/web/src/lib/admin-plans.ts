import { prisma } from "@brandai/db";
import type { AdminPlanSummary } from "@brandai/contracts";

/**
 * Platform plan (tier) listing (/admin/plans). Returns every subscription tier
 * with its operator-editable quota knobs, ordered cheapest → most expensive so
 * the table reads STARTER → PRO → TEAM → ENTERPRISE.
 *
 * Single source of truth shared by the GET route and the server page so the
 * shape can't drift. These rows are exactly what lib/quota.ts#resolvePlan reads
 * to enforce quota, so editing them here changes enforcement immediately.
 */
export async function listAdminPlans(): Promise<AdminPlanSummary[]> {
  const plans = await prisma.plan.findMany({
    orderBy: { priceCentsMonthly: "asc" },
    select: {
      tier: true,
      name: true,
      priceCentsMonthly: true,
      monthlyGenerationQuota: true,
      dailyGenerationLimit: true,
      maxWorkspaces: true,
    },
  });
  return plans;
}

import { prisma } from "@brandai/db";
import type { AdminUserSummary } from "@brandai/contracts";
import { effectiveAdmin } from "@/lib/quota";

/**
 * Platform user-management listing (/admin/users). Returns every registered
 * user with the operator-relevant facts: brand-space count, effective
 * subscription quota (STARTER defaults when no active subscription), and the
 * enabled/admin flags the table acts on.
 *
 * Single source of truth shared by the GET route and the server page so the
 * shape can't drift. Cheap enough to run unpaginated at this scale (one query
 * for users + counts + subscription, one for the STARTER fallback).
 */
export async function listAdminUsers(): Promise<AdminUserSummary[]> {
  const [users, starter, enterprise] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        email: true,
        name: true,
        isAdmin: true,
        isActive: true,
        createdAt: true,
        _count: { select: { workspaces: true } },
        subscription: {
          select: {
            status: true,
            plan: {
              select: {
                tier: true,
                name: true,
                monthlyGenerationQuota: true,
                dailyGenerationLimit: true,
              },
            },
          },
        },
      },
    }),
    prisma.plan.findUnique({ where: { tier: "STARTER" } }),
    prisma.plan.findUnique({ where: { tier: "ENTERPRISE" } }),
  ]);

  // Fallback plans mirror lib/quota.ts#resolvePlan: no Subscription → STARTER
  // for end users, ENTERPRISE for platform admins (so the table shows the
  // operator at the tier they're actually metered at — unlimited).
  const starterPlan = {
    tier: "STARTER",
    name: starter?.name ?? "Starter",
    monthlyGenerationQuota: starter?.monthlyGenerationQuota ?? 600,
    dailyGenerationLimit: starter?.dailyGenerationLimit ?? 30,
  };
  const enterprisePlan = {
    tier: "ENTERPRISE",
    name: enterprise?.name ?? "Enterprise",
    monthlyGenerationQuota: enterprise?.monthlyGenerationQuota ?? -1,
    dailyGenerationLimit: enterprise?.dailyGenerationLimit ?? -1,
  };

  return users.map((u) => {
    const sub = u.subscription;
    const isOperator = effectiveAdmin(u.email, u.isAdmin);
    const plan =
      sub && sub.status === "ACTIVE" && sub.plan
        ? sub.plan
        : isOperator
          ? enterprisePlan
          : starterPlan;
    return {
      id: u.id,
      email: u.email,
      ...(u.name ? { name: u.name } : {}),
      isAdmin: isOperator,
      isActive: u.isActive,
      createdAt: u.createdAt.toISOString(),
      workspaceCount: u._count.workspaces,
      planTier: plan.tier,
      planName: plan.name,
      monthlyGenerationQuota: plan.monthlyGenerationQuota,
      dailyGenerationLimit: plan.dailyGenerationLimit,
    };
  });
}

import { prisma, PlanTier } from "@brandai/db";
import { AdminUpdatePlanInput } from "@brandai/contracts";
import { ApiException, handleError, ok, parse } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { listAdminPlans } from "@/lib/admin-plans";

/**
 * Admin-only — edit a subscription tier's quota knobs (daily rate limit /
 * period quota / max brand workspaces / display name). `-1` = unlimited.
 *
 * These are the exact rows lib/quota.ts#resolvePlan reads, so the change takes
 * effect on the very next generation — no redeploy. Raising STARTER (the tier
 * every user without an active subscription resolves to) opens quota for all
 * default-tier designers at once. Returns the refreshed list so the client
 * re-renders from the server truth.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ tier: string }> },
) {
  try {
    await requireAdmin();
    const { tier } = await params;

    // Guard the enum before it reaches Prisma — an unknown value would be a
    // validation error (500), not a clean 404.
    if (!(tier in PlanTier)) throw new ApiException(404, "Plan not found");
    const existing = await prisma.plan.findUnique({
      where: { tier: tier as PlanTier },
    });
    if (!existing) throw new ApiException(404, "Plan not found");

    const input = parse(AdminUpdatePlanInput, await req.json());
    await prisma.plan.update({
      where: { tier: tier as PlanTier },
      data: {
        name: input.name,
        monthlyGenerationQuota: input.monthlyGenerationQuota,
        dailyGenerationLimit: input.dailyGenerationLimit,
        maxWorkspaces: input.maxWorkspaces,
      },
    });

    return ok({ plans: await listAdminPlans() });
  } catch (err) {
    return handleError(err);
  }
}

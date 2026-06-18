import { handleError, ok, requireUser } from "@/lib/api";
import { getUsage, quotaEnabled } from "@/lib/quota";

/**
 * M-D · GET /api/me/subscription — the caller's effective plan plus current
 * daily/period generation usage, so the UI can show remaining quota and the
 * 402 wall has a self-serve "upgrade" surface. Read-only; D4/D5.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const { plan, dailyUsed, periodUsed } = await getUsage(user.id);
    return ok({
      enabled: quotaEnabled(),
      plan: {
        tier: plan.tier,
        name: plan.name,
        monthlyGenerationQuota: plan.monthlyGenerationQuota,
        dailyGenerationLimit: plan.dailyGenerationLimit,
        maxWorkspaces: plan.maxWorkspaces,
        periodStart: plan.periodStart.toISOString(),
      },
      usage: { dailyUsed, periodUsed },
    });
  } catch (err) {
    return handleError(err);
  }
}

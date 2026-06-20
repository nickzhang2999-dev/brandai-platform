import { handleError, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { getUsageSummary } from "@/lib/usage";

/**
 * T-conn-b · GET → admin usage/cost summary (last N days, grouped by day×model).
 * Gated to the platform admin via requireAdmin.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin();
    const sinceDays = Number(
      new URL(req.url).searchParams.get("days") ?? "30",
    );
    const days = Number.isFinite(sinceDays) && sinceDays > 0 ? Math.min(sinceDays, 365) : 30;
    return ok(await getUsageSummary(days));
  } catch (err) {
    return handleError(err);
  }
}

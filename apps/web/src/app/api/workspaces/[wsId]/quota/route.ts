import { handleError, ok, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { getQuotaStatus, quotaEnabled } from "@/lib/quota";

/**
 * GET /api/workspaces/[wsId]/quota
 *   → QuotaStatus { dailyUsed, dailyLimit, periodUsed, monthlyQuota, plan }
 *
 * F11 — read-only quota display. Reuses the same plan resolution + usage
 * counting as the 402 enforcement gate (lib/quota.ts), so the UI never
 * disagrees with what actually blocks generation. `-1` on a limit = unlimited.
 *
 * Honors the QUOTA_V1 env toggle the same way enforcement does: when quota is
 * disabled, nothing is enforced, so we report unlimited limits (-1) for the
 * resolved plan instead of counting against a cap that isn't applied.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    // Read-only: any workspace member may view quota status.
    await requireWorkspaceRole(wsId, user.id, "VIEWER");

    const status = await getQuotaStatus(user.id);
    if (!quotaEnabled()) {
      return ok({ ...status, dailyLimit: -1, monthlyQuota: -1 });
    }
    return ok(status);
  } catch (err) {
    return handleError(err);
  }
}

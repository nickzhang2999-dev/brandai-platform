import { handleError, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { listAdminPlans } from "@/lib/admin-plans";

/**
 * Admin-only — list every subscription tier with its editable quota knobs.
 * Gated by ADMIN_EMAILS (or the bootstrap admin) via requireAdmin.
 */
export async function GET() {
  try {
    await requireAdmin();
    return ok({ plans: await listAdminPlans() });
  } catch (err) {
    return handleError(err);
  }
}

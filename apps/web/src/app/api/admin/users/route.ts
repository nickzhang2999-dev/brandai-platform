import { handleError, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { listAdminUsers } from "@/lib/admin-users";

/**
 * Admin-only — list every registered user with brand-space count + effective
 * subscription quota. Gated by ADMIN_EMAILS (or the bootstrap admin) via
 * requireAdmin.
 */
export async function GET() {
  try {
    await requireAdmin();
    return ok({ users: await listAdminUsers() });
  } catch (err) {
    return handleError(err);
  }
}

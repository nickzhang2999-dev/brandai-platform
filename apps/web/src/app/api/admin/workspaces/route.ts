import { handleError, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { listAllWorkspaces } from "@/lib/admin-workspaces";

/**
 * Admin-only — list EVERY brand workspace across all owners (read-only).
 * Gated by ADMIN_EMAILS (or the bootstrap admin) via requireAdmin.
 */
export async function GET() {
  try {
    await requireAdmin();
    return ok({ workspaces: await listAllWorkspaces() });
  } catch (err) {
    return handleError(err);
  }
}

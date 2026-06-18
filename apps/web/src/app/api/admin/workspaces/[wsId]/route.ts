import { handleError, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/admin";
import { getWorkspaceDetailForAdmin } from "@/lib/admin-workspaces";

/**
 * Admin-only — full read-only detail of any workspace (members, rules,
 * projects, generations + generated images), regardless of owner. 404 when the
 * workspace doesn't exist. Gated via requireAdmin.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    await requireAdmin();
    const { wsId } = await params;
    return ok(await getWorkspaceDetailForAdmin(wsId));
  } catch (err) {
    return handleError(err);
  }
}

import { QueueResponse } from "@brandai/contracts";
import { handleError, ok, requireUser } from "@/lib/api";
import { requireOwnedWorkspace } from "@/lib/workspace";
import { listWorkspaceQueue } from "@/lib/generations";

/**
 * §2.3 · GET /api/workspaces/[wsId]/queue
 *
 * Workspace-scoped queue snapshot for the bottom-right widget. Active rows
 * (PENDING/RUNNING) float to the top, then the most recent N terminal rows.
 * The widget polls fast (2.5s) while `activeCount > 0` and backs off when idle
 * — see `lib/generations.ts#listWorkspaceQueue` for the coarse-progress note.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    const data = await listWorkspaceQueue(wsId);
    return ok(QueueResponse.parse(data));
  } catch (err) {
    return handleError(err);
  }
}

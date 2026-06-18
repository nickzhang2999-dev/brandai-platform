import { ApiException, handleError, ok, requireUser } from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { restoreRuleSnapshot } from "@/lib/rule-snapshots";

/**
 * C8 · POST → roll the workspace's CONFIRMED rule library back to this
 * snapshot. Reversible: the pre-restore state is auto-captured as a backup
 * snapshot first (returned as `backupSnapshotId`).
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; snapshotId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, snapshotId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");
    try {
      const result = await restoreRuleSnapshot(wsId, snapshotId, user.id);
      return ok(result);
    } catch (e) {
      if (e instanceof Error && e.message === "SNAPSHOT_NOT_FOUND") {
        throw new ApiException(404, "Snapshot not found");
      }
      throw e;
    }
  } catch (err) {
    return handleError(err);
  }
}

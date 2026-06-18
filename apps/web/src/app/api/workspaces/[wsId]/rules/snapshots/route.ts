import { CreateRuleSnapshotInput } from "@brandai/contracts";
import { handleError, ok, parse, requireUser } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { createRuleSnapshot, listRuleSnapshots } from "@/lib/rule-snapshots";

/**
 * C8 · GET → list the workspace's rule version snapshots (newest first).
 *      POST → capture the current CONFIRMED rule set as a named version.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    return ok({ snapshots: await listRuleSnapshots(wsId) });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");
    const input = parse(CreateRuleSnapshotInput, await req.json());
    const snapshot = await createRuleSnapshot(wsId, input, user.id);
    return ok(snapshot, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}

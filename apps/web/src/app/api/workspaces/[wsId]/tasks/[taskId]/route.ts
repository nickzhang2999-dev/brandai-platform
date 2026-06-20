import { ApiException, handleError, ok, requireUser } from "@/lib/api";
import { requireOwnedWorkspace } from "@/lib/workspace";
import { getTask } from "@/lib/async-tasks";

/**
 * H-async · GET → server-authoritative async task state (status/progress/refId)
 * so recognize/parse-manual/edit views can resume after a refresh (`?task=`).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string; taskId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, taskId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    const task = await getTask(wsId, taskId);
    if (!task) throw new ApiException(404, "Task not found");
    return ok(task);
  } catch (err) {
    return handleError(err);
  }
}

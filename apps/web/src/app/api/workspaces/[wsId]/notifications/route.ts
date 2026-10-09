import { NotificationsResponse } from "@brandai/contracts";
import { ApiException, handleError, ok, requireUser } from "@/lib/api";
import { requireOwnedWorkspace } from "@/lib/workspace";
import { listWorkspaceNotifications } from "@/lib/notifications";

/**
 * A3 / L3 · GET /api/workspaces/[wsId]/notifications
 *
 * Workspace-scoped terminal-event inbox for the top-bar bell. Derived on read
 * from real `Generation` + `AsyncTask` rows (no persisted Notification table) —
 * see `lib/notifications.ts`. Unread state is client-side (localStorage
 * `lastSeenAt` vs each item's `createdAt`). Member-gated like the queue widget.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const expectedUser = req.headers.get("X-Novart-User");
    if (expectedUser && expectedUser !== user.id) throw new ApiException(409, "登录账号已切换，请刷新页面后查看通知。");
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    const items = await listWorkspaceNotifications(wsId, 30, user.id);
    return ok(NotificationsResponse.parse({ items }));
  } catch (err) {
    return handleError(err);
  }
}

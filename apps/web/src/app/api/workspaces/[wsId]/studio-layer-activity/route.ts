import { ApiException, handleError, requireUser } from "@/lib/api";
import { requireOwnedWorkspace } from "@/lib/workspace";
import { listStudioLayerActivity } from "@/lib/studio-layer-notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ wsId: string }> }) {
  try {
    const user = await requireUser();
    const expectedUser = req.headers.get("X-Novart-User");
    if (expectedUser && expectedUser !== user.id) throw new ApiException(409, "登录账号已切换，请刷新页面后查看任务。");
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);
    return Response.json(await listStudioLayerActivity(wsId, user.id), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const response = handleError(error);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}

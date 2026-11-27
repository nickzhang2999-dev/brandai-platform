import { ApiException, requireUser } from "@/lib/api";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { readWorkbenchJson } from "@/lib/workbench-request";
import { listPosterBriefs, createPosterBrief, confirmPosterAppearance } from "@/lib/sol-poster-brief";
import { ZodError } from "zod";
import { nativeDispatchEnabled, posterPlanner } from "@/lib/deepflare-v2/feature";
type Context = { params: Promise<{ wsId: string; projectId: string }> };
async function handle(req: Request, ctx: Context) {
  try {
    const user = await requireUser();
    if (req.headers.get("X-Novart-User") !== user.id) throw new ApiException(409, "账号已切换，请刷新。");
    const { wsId, projectId } = await ctx.params;
    if (req.method === "GET") return Response.json(await listPosterBriefs(wsId, projectId, user.id), { headers: {
      "Cache-Control": "no-store", "X-Sol-Conversation":posterPlanner(wsId) ? "1" : "0",
      "X-Sol-Appearance": nativeDispatchEnabled(wsId) ? "1" : "0" } });
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "请求来源无效。");
    const input = await readWorkbenchJson(req, 8192);
    if (typeof input === "object" && input !== null && "action" in input && input.action === "confirm-appearance")
      return Response.json(await confirmPosterAppearance(wsId, projectId, user.id, input), { status: 202 });
    return Response.json(await createPosterBrief(wsId, projectId, user.id, input), { status: 202 });
  } catch (e) {
    return Response.json({ error: e instanceof ApiException ? e.message : e instanceof ZodError ? "请重新选择已保存的商品图片。" : "暂时无法读取简报。" },
      { status: e instanceof ApiException ? e.status : e instanceof ZodError ? 422 : 503 });
  }
}
export const GET = handle;
export const POST = handle;

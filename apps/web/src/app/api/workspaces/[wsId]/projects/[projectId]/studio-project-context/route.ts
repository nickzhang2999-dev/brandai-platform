import { ApiException, requireUser } from "@/lib/api";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { readWorkbenchJson } from "@/lib/workbench-request";
import { readStudioProjectContext, saveStudioProjectContext } from "@/lib/studio-project-context";
import { ZodError } from "zod";
type Context = { params: Promise<{ wsId: string; projectId: string }> };
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
async function handle(req: Request, context: Context) {
  try {
    const user = await requireUser(), { wsId, projectId } = await context.params;
    const expectedUser = req.headers.get("X-Novart-User");
    if (expectedUser !== null && expectedUser !== user.id) throw new ApiException(409, "账号已切换，请重新打开工作台。");
    if (req.method === "GET") return json(await readStudioProjectContext(wsId, user.id, projectId));
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin write rejected");
    return json(await saveStudioProjectContext(wsId, user.id, projectId, await readWorkbenchJson(req, 48 * 1024)));
  } catch (error) {
    if (error instanceof ApiException) return json({ error: error.message }, error.status);
    if (error instanceof ZodError) return json({ error: "项目资料格式不正确，请检查后重试。" }, 422);
    return json({ error: "项目资料暂时无法保存或读取，当前输入仍保留。" }, 503);
  }
}
export const GET = handle;
export const PUT = handle;

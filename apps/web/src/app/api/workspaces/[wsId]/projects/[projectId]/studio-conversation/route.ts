import { ApiException, requireUser } from "@/lib/api";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { readWorkbenchJson } from "@/lib/workbench-request";
import { readStudioConversation, submitStudioConversation, saveStudioConversationDraft } from "@/lib/studio-conversation";
import { ZodError } from "zod";
type Context = { params: Promise<{ wsId: string; projectId: string }> };
export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
async function handle(req: Request, context: Context) {
  try {
    const user = await requireUser(); const { wsId, projectId } = await context.params;
    const expectedUser = req.headers.get("X-Novart-User");
    if (expectedUser !== null && expectedUser !== user.id) throw new ApiException(409, "账号已切换，请重新打开工作台。");
    if (req.method !== "GET" && !isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin write rejected");
    if (req.method === "GET") return json(await readStudioConversation(wsId, user.id, projectId, Object.fromEntries(new URL(req.url).searchParams)));
    const body = await readWorkbenchJson(req, 32 * 1024);
    if (req.method === "PUT") return json(await saveStudioConversationDraft(wsId, user.id, projectId, body));
    return json(await submitStudioConversation(wsId, user.id, projectId, body), 202);
  } catch (error) {
    if (error instanceof ApiException) return json({ error: error.message }, error.status);
    if (error instanceof ZodError) return json({ error: "对话输入格式不正确，请检查后重试。" }, 422);
    return json({ error: "对话暂时不可用，输入仍保留，请稍后重试。" }, 503);
  }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;

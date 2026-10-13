import { ZodError } from "zod";
import { requireUser, ApiException } from "@/lib/api";
import { readStudioGeneratedPsd } from "@/lib/studio-generated-psd";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" };
export async function GET(req: Request, context: { params: Promise<{ wsId: string }> }) {
  try {
    const user = await requireUser(), { wsId } = await context.params;
    const query = new URL(req.url).searchParams;
    for (const key of query.keys()) {
      if (!["projectId", "requestId", "workspaceId"].includes(key) || query.getAll(key).length !== 1) throw new ApiException(422, "请求参数不正确。");
    }
    if (query.has("workspaceId") && query.get("workspaceId") !== wsId) throw new ApiException(422, "品牌参数与访问地址不一致。");
    return Response.json(await readStudioGeneratedPsd(wsId, user.id, Object.fromEntries([...query].filter(([key]) => key !== "workspaceId"))), { headers });
  } catch (error) {
    return Response.json({ error: error instanceof ApiException ? error.message : error instanceof ZodError ? "请求格式不正确。" : "自动 PSD 状态暂时不可读取，请稍后重试。" },
      { status: error instanceof ApiException ? error.status : error instanceof ZodError ? 422 : 503, headers });
  }
}

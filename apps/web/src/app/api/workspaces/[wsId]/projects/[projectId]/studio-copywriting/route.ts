import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { requireUser, ApiException } from "@/lib/api";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { readWorkbenchJson } from "@/lib/workbench-request";
import { listCopywriting, submitCopywriting } from "@/lib/studio-copywriting";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ wsId: string; projectId: string }> };
function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof ApiException ? error.message : error instanceof ZodError ? "请填写文案需求，并检查所选原文或图片。" : "暂时无法读取文案任务，请稍后重试。" },
    { status: error instanceof ApiException ? error.status : error instanceof ZodError ? 422 : 503 });
}
async function userFor(request: Request) {
  const user = await requireUser();
  if (request.headers.get("X-Novart-User") !== user.id) throw new ApiException(409, "账号已切换，请重新打开工作台。");
  return user;
}
export async function GET(request: Request, context: Context) {
  try { const user = await userFor(request); const { wsId, projectId } = await context.params;
    return NextResponse.json(await listCopywriting(wsId, projectId, user.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  try { const user = await userFor(request); const { wsId, projectId } = await context.params;
    if (!isWorkbenchSameOrigin(request)) throw new ApiException(403, "Cross-origin request rejected");
    return NextResponse.json(await submitCopywriting(wsId, projectId, user.id, await readWorkbenchJson(request, 32 * 1024)), { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

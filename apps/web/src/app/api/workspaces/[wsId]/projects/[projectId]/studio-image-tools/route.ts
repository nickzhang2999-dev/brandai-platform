import { StudioImageToolInput } from "@brandai/contracts";
import { NextResponse } from "next/server";
import { requireUser, ApiException } from "@/lib/api";
import { ZodError } from "zod";
import { requireStudioMaterialProject } from "@/lib/studio-materials";
import { studioImageToolCapabilities, submitStudioImageTool } from "@/lib/studio-image-tools";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { readWorkbenchJson } from "@/lib/workbench-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ wsId: string; projectId: string }> };
function errorResponse(error: unknown) {
  if (error instanceof ApiException) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return NextResponse.json({ error: "图片工具输入无效，请检查目标与蒙版。" }, { status: 422 });
  return NextResponse.json({ error: "图片工具暂时不可用，原图仍保留，请稍后读取任务状态。" }, { status: 503 });
}
async function userFor(request: Request) {
  const user = await requireUser(), expected = request.headers.get("X-Novart-User");
  if (expected !== null && expected !== user.id) throw new ApiException(409, "账号已切换，请重新打开工作台。");
  return user;
}
export async function GET(request: Request, context: Context) {
  try {
    const user = await userFor(request); const { wsId, projectId } = await context.params;
    await requireStudioMaterialProject(wsId, user.id, projectId);
    return NextResponse.json(await studioImageToolCapabilities(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const user = await userFor(request); const { wsId, projectId } = await context.params;
    if (!isWorkbenchSameOrigin(request)) throw new ApiException(403, "Cross-origin request rejected");
    const input = StudioImageToolInput.parse(await readWorkbenchJson(request, 2 * 1024 * 1024));
    if (input.projectId !== projectId) throw new ApiException(422, "工具请求与当前项目不一致。");
    return NextResponse.json(await submitStudioImageTool(wsId, user.id, input), { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

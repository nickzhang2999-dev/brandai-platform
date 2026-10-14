import { handleError, ok, ApiException } from "@/lib/api";
import { requireStudioBrandMaterialUser } from "@/lib/studio-brand-materials-user";
import { submitStudioBrandMaterialUpload, readStudioBrandMaterialUploads } from "@/lib/studio-materials";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
type Context = { params: Promise<{ wsId: string }> };
export async function GET(req: Request, { params }: Context) {
  try {
    const user = await requireStudioBrandMaterialUser(req), { wsId } = await params, url = new URL(req.url);
    for (const key of url.searchParams.keys()) if (key !== "taskId") throw new ApiException(422, "品牌上传查询字段无效。");
    return ok(await readStudioBrandMaterialUploads(wsId, user.id, url.searchParams.get("taskId") ?? undefined), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleError(error); }
}
export async function POST(req: Request, { params }: Context) {
  try {
    const user = await requireStudioBrandMaterialUser(req), { wsId } = await params;
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin write rejected");
    return ok(await submitStudioBrandMaterialUpload(wsId, user.id, req), { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleError(error); }
}

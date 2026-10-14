import { handleError, ok, ApiException } from "@/lib/api";
import { requireStudioBrandMaterialUser } from "@/lib/studio-brand-materials-user";
import { readStudioBrandMaterial, mutateStudioBrandMaterial } from "@/lib/studio-brand-materials";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { readWorkbenchJson } from "@/lib/workbench-request";
type Context = { params: Promise<{ wsId: string; assetId: string }> };
export async function GET(req: Request, { params }: Context) {
  try {
    const user = await requireStudioBrandMaterialUser(req), { wsId, assetId } = await params;
    return ok(await readStudioBrandMaterial(wsId, user.id, assetId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleError(error); }
}
export async function POST(req: Request, { params }: Context) {
  try {
    const user = await requireStudioBrandMaterialUser(req), { wsId, assetId } = await params;
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin write rejected");
    const raw = await readWorkbenchJson(req, 4096);
    return ok(await mutateStudioBrandMaterial(wsId, user.id, assetId, raw), { status: (raw as { operation?: string })?.operation === "verify" ? 202 : 200,
      headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleError(error); }
}

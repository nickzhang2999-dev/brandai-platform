import { handleError, ok } from "@/lib/api";
import { requireStudioBrandMaterialUser } from "@/lib/studio-brand-materials-user";
import { listStudioBrandMaterials } from "@/lib/studio-brand-materials";
export async function GET(req: Request, { params }: { params: Promise<{ wsId: string }> }) {
  try {
    const user = await requireStudioBrandMaterialUser(req), { wsId } = await params, url = new URL(req.url);
    const raw = Object.fromEntries(url.searchParams);
    return ok(await listStudioBrandMaterials(wsId, user.id, { ...raw, ...(raw.limit ? { limit: Number(raw.limit) } : {}) }),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleError(error); }
}

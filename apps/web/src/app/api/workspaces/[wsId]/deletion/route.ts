import { ApiException, handleError, ok, requireUser } from "@/lib/api";
import { previewBrandDeletion } from "@/lib/brand-deletion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ wsId: string }> }) {
  try {
    const user = await requireUser();
    const expectedUser = req.headers.get("X-Novart-User");
    if (expectedUser && expectedUser !== user.id) throw new ApiException(409, "登录账号已切换，请刷新后再检查品牌。");
    const { wsId } = await params;
    return ok(await previewBrandDeletion(wsId, user.id), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return handleError(error); }
}

import { cookies } from "next/headers";
import { SelectWorkbenchWorkspaceInput } from "@brandai/contracts";
import { ApiException, handleError, requireUser } from "@/lib/api";
import { getWorkbenchSession } from "@/lib/workbench-session";
import { ACTIVE_BRAND_COOKIE, ACTIVE_BRAND_COOKIE_MAX_AGE } from "@/lib/brand-cookie";
import { readWorkbenchJson } from "@/lib/workbench-request";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const requested = new URL(req.url).searchParams.get("workspaceId");
    const preferred = requested ?? (await cookies()).get(ACTIVE_BRAND_COOKIE)?.value;
    const result = await getWorkbenchSession(user, preferred, requested !== null);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleError(error); }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin write rejected");
    const raw = await readWorkbenchJson(req, 1024);
    const { workspaceId } = SelectWorkbenchWorkspaceInput.parse(raw);
    const result = await getWorkbenchSession(user, workspaceId, true);
    (await cookies()).set(ACTIVE_BRAND_COOKIE, workspaceId, {
      path: "/", maxAge: ACTIVE_BRAND_COOKIE_MAX_AGE, sameSite: "lax",
      secure: new URL(req.url).protocol === "https:",
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleError(error); }
}

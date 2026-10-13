import { handleError, ApiException } from "@/lib/api";
import { studioSession } from "@/lib/studio-session";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { readWorkbenchJson } from "@/lib/workbench-request";
import { retryStudioLayerArchive } from "@/lib/studio-decomposition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  try {
    const { workspaceId, user } = await studioSession(req);
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin write rejected");
    return Response.json(await retryStudioLayerArchive(workspaceId, user.id, await readWorkbenchJson(req, 1024)), { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return handleError(error); }
}

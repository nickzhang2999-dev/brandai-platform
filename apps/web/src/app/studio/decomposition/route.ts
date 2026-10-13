import { handleError, ApiException } from "@/lib/api";
import { studioSession } from "@/lib/studio-session";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { readWorkbenchJson } from "@/lib/workbench-request";
import { readStudioDecompositions, submitStudioDecomposition } from "@/lib/studio-decomposition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
export async function GET(req: Request) {
  try {
    const { workspaceId, user } = await studioSession(req), query = new URL(req.url).searchParams;
    return reply(await readStudioDecompositions(workspaceId, user.id, { projectId: query.get("projectId"), ...(query.has("requestId") ? { requestId: query.get("requestId") } : {}) }));
  } catch (error) { return handleError(error); }
}
export async function POST(req: Request) {
  try {
    const { workspaceId, user } = await studioSession(req);
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin write rejected");
    return reply(await submitStudioDecomposition(workspaceId, user.id, await readWorkbenchJson(req, 8192)), 202);
  } catch (error) { return handleError(error); }
}

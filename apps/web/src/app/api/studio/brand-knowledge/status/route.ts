import { handleError, ok } from "@/lib/api";
import { studioSession } from "@/lib/studio-session";
import { readStudioBrandRuleStatus } from "@/lib/studio-brand-rule-status";

export async function GET(req: Request) {
  try {
    const { user, workspaceId } = await studioSession(req);
    return ok(await readStudioBrandRuleStatus(workspaceId, user.id), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return handleError(error); }
}

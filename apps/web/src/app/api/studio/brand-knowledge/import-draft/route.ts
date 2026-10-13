import { ApiException, handleError, ok } from "@/lib/api";
import { studioSession } from "@/lib/studio-session";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { importStudioBrandDraft, readStudioBrandDraftImport } from "@/lib/studio-brand-knowledge";

export async function GET(req: Request) {
  try {
    const { user, workspaceId } = await studioSession(req);
    return ok(await readStudioBrandDraftImport(workspaceId, user.id));
  } catch (error) { return handleError(error); }
}

export async function POST(req: Request) {
  try {
    const { user, workspaceId } = await studioSession(req);
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "写入来源不匹配，请重新打开当前工作台。");
    return ok(await importStudioBrandDraft(workspaceId, user.id, await req.json()));
  } catch (error) { return handleError(error); }
}

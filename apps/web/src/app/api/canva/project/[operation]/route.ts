import { EDITOR_DOCUMENT_MAX_BYTES } from "@brandai/contracts";
import { ApiException } from "@/lib/api";
import { studioSession } from "@/lib/studio-session";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { readWorkbenchJson } from "@/lib/workbench-request";
import { queryNativeProject, saveNativeProject, listNativeProjects, renameNativeProject } from "@/lib/native-projects";
import { nativeResponse, nativeErrorResponse } from "@/lib/native-project-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const operations = {
  queryProject: queryNativeProject, saveProject: saveNativeProject,
  lovartProjectList: listNativeProjects, updateProjectName: renameNativeProject,
};

export async function POST(req: Request, { params }: { params: Promise<{ operation: string }> }) {
  try {
    const { user, workspaceId } = await studioSession(req);
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin request rejected");
    const { operation } = await params;
    if (!Object.prototype.hasOwnProperty.call(operations, operation)) throw new ApiException(503, "此编辑器服务尚未接入。");
    const input = await readWorkbenchJson(req, operation === "saveProject" ? EDITOR_DOCUMENT_MAX_BYTES + 128 * 1024 : 4096);
    return nativeResponse(await operations[operation as keyof typeof operations](workspaceId, user.id, input));
  } catch (error) { return nativeErrorResponse(error); }
}

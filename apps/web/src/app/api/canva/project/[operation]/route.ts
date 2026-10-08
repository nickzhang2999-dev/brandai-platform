import { cookies } from "next/headers";
import { EDITOR_DOCUMENT_MAX_BYTES, SelectWorkbenchWorkspaceInput } from "@brandai/contracts";
import { ApiException, requireUser } from "@/lib/api";
import { ACTIVE_BRAND_COOKIE } from "@/lib/brand-cookie";
import { getWorkbenchSession } from "@/lib/workbench-session";
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
    const user = await requireUser();
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin request rejected");
    const { operation } = await params;
    if (!Object.prototype.hasOwnProperty.call(operations, operation)) throw new ApiException(503, "此编辑器服务尚未接入。");
    // Native requests can carry an explicit workspace from the future shell
    // bootstrap. A changed brand cookie must not retarget an already open tab.
    const explicit = new URL(req.url).searchParams.get("workspaceId");
    if (explicit !== null) SelectWorkbenchWorkspaceInput.parse({ workspaceId: explicit });
    const preferred = explicit ?? (await cookies()).get(ACTIVE_BRAND_COOKIE)?.value;
    const session = await getWorkbenchSession(user, preferred, preferred !== undefined);
    if (!session.activeWorkspaceId) throw new ApiException(409, "请先创建或选择品牌。");
    const input = await readWorkbenchJson(req, operation === "saveProject" ? EDITOR_DOCUMENT_MAX_BYTES + 128 * 1024 : 4096);
    return nativeResponse(await operations[operation as keyof typeof operations](session.activeWorkspaceId, user.id, input));
  } catch (error) { return nativeErrorResponse(error); }
}

import { prisma } from "@brandai/db";
import { NativeProjectQueryInput } from "@brandai/contracts";
import { ApiException } from "@/lib/api";
import { studioSession } from "@/lib/studio-session";
import { readEditorDocument } from "@/lib/editor-documents";
import { readWorkbenchJson } from "@/lib/workbench-request";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { nativeResponse, nativeErrorResponse } from "@/lib/native-project-response";
export const dynamic = "force-dynamic";
export async function POST(req: Request, { params }: { params: Promise<{ operation: string }> }) {
  try {
    const { user, workspaceId } = await studioSession(req);
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin request rejected");
    const { operation } = await params;
    if (operation !== "queryAgentLastThread") throw new ApiException(503, "AI 服务正在接入，尚未提交生成任务。");
    const { projectId } = NativeProjectQueryInput.parse(await readWorkbenchJson(req, 4096));
    await readEditorDocument(workspaceId, projectId, user.id);
    const existing = await prisma.generation.count({ where: { workspaceId, projectId } });
    if (existing) throw new ApiException(503, "这个项目已有生成历史，历史记录适配尚未完成。");
    return nativeResponse(null);
  } catch (error) { return nativeErrorResponse(error); }
}

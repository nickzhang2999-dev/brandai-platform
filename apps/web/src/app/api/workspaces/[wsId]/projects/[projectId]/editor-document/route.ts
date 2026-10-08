import { EDITOR_DOCUMENT_MAX_BYTES } from "@brandai/contracts";
import { handleError, requireUser, ApiException } from "@/lib/api";
import { EditorDocumentError } from "@/lib/editor-document-codec";
import { readEditorDocument, saveEditorDocument } from "@/lib/editor-documents";
import { readWorkbenchJson } from "@/lib/workbench-request";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ wsId: string; projectId: string }> };
const respond = (data: unknown) => Response.json(data, { headers: { "Cache-Control": "no-store" } });
function errorResponse(error: unknown) {
  if (error instanceof EditorDocumentError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  return handleError(error);
}

export async function GET(_req: Request, { params }: Context) {
  try {
    const user = await requireUser();
    const { wsId, projectId } = await params;
    return respond(await readEditorDocument(wsId, projectId, user.id));
  } catch (error) { return errorResponse(error); }
}

export async function PUT(req: Request, { params }: Context) {
  try {
    const user = await requireUser();
    if (!isWorkbenchSameOrigin(req)) throw new ApiException(403, "Cross-origin write rejected");
    const body = await readWorkbenchJson(req, EDITOR_DOCUMENT_MAX_BYTES + 4096);
    const { wsId, projectId } = await params;
    return respond(await saveEditorDocument(wsId, projectId, user.id, body));
  } catch (error) { return errorResponse(error); }
}

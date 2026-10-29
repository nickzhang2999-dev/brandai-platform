import { writingRouteScope, writingResponse, writingFailure, type WritingRouteContext } from "@/lib/studio-writing-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { uploadWritingReference, requireWritingScope } from "@/lib/studio-writing";
import { readWritingUpload } from "@/lib/studio-writing-http";
import { readWorkbenchJson } from "@/lib/workbench-request";
import { StudioWritingAssetReferenceInput } from "@brandai/contracts";
export async function POST(request: Request, context: WritingRouteContext) {
 try { const scope = await writingRouteScope(request, context, true); await requireWritingScope(scope, true);
 const input = request.headers.get("content-type")?.startsWith("application/json") ? StudioWritingAssetReferenceInput.parse(await readWorkbenchJson(request, 8192)) : await readWritingUpload(request);
 return writingResponse(await uploadWritingReference(scope, input), 202); } catch (error) { return writingFailure(error); }
}

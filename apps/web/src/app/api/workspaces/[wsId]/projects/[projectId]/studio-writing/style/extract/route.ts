import { writingRouteScope, writingResponse, writingFailure, type WritingRouteContext } from "@/lib/studio-writing-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { submitWriting } from "@/lib/studio-writing";
import { readWorkbenchJson } from "@/lib/workbench-request";
export async function POST(request: Request, context: WritingRouteContext) {
 try { const scope = await writingRouteScope(request, context, true); return writingResponse(await submitWriting(scope, await readWorkbenchJson(request, 32 * 1024), true), 202); } catch (error) { return writingFailure(error); }
}

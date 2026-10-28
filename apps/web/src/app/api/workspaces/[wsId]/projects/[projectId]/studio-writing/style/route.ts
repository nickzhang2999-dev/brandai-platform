import { writingRouteScope, writingResponse, writingFailure, type WritingRouteContext } from "@/lib/studio-writing-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { readWritingStyle, saveWritingStyle } from "@/lib/studio-writing";
import { readWorkbenchJson } from "@/lib/workbench-request";
export async function GET(request: Request, context: WritingRouteContext) {
 try { return writingResponse(await readWritingStyle(await writingRouteScope(request, context))); } catch (error) { return writingFailure(error); }
}
export async function PUT(request: Request, context: WritingRouteContext) {
 try { const scope = await writingRouteScope(request, context, true); return writingResponse(await saveWritingStyle(scope, await readWorkbenchJson(request, 256 * 1024))); } catch (error) { return writingFailure(error); }
}

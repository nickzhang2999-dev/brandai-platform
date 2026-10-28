import { writingRouteScope, writingResponse, writingFailure, type WritingRouteContext } from "@/lib/studio-writing-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { writingState, saveWriting, submitWriting } from "@/lib/studio-writing";
import { StudioWritingState } from "@brandai/contracts";
import { readWorkbenchJson } from "@/lib/workbench-request";
export async function GET(request: Request, context: WritingRouteContext) {
 try { return writingResponse(StudioWritingState.parse(await writingState(await writingRouteScope(request, context)))); } catch (error) { return writingFailure(error); }
}
export async function PUT(request: Request, context: WritingRouteContext) {
 try { const scope = await writingRouteScope(request, context, true); return writingResponse(await saveWriting(scope, await readWorkbenchJson(request, 512 * 1024))); } catch (error) { return writingFailure(error); }
}
export async function POST(request: Request, context: WritingRouteContext) {
 try { const scope = await writingRouteScope(request, context, true); return writingResponse(await submitWriting(scope, await readWorkbenchJson(request, 128 * 1024)), 202); } catch (error) { return writingFailure(error); }
}

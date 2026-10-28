import { writingRouteScope, writingResponse, writingFailure, type WritingRouteContext } from "@/lib/studio-writing-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { writingTask } from "@/lib/studio-writing";
export async function GET(request: Request, context: WritingRouteContext) {
 try { const scope = await writingRouteScope(request, context); const { taskId } = await context.params; return writingResponse(await writingTask(scope, taskId!)); } catch (error) { return writingFailure(error); }
}

import { writingRouteScope, writingResponse, writingFailure, type WritingRouteContext } from "@/lib/studio-writing-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { z } from "zod";
import { lookupWritingTask } from "@/lib/studio-writing";
export async function GET(request: Request, context: WritingRouteContext) {
 try { const scope = await writingRouteScope(request, context); const mutationId = z.string().uuid().parse(new URL(request.url).searchParams.get("mutationId")); return writingResponse(await lookupWritingTask(scope, mutationId)); } catch (error) { return writingFailure(error); }
}

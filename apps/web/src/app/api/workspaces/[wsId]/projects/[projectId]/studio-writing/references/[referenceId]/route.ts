import { writingRouteScope, writingResponse, writingFailure, type WritingRouteContext } from "@/lib/studio-writing-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { deleteWritingReference } from "@/lib/studio-writing";
export async function DELETE(request: Request, context: WritingRouteContext) {
 try { const scope = await writingRouteScope(request, context, true); const { referenceId } = await context.params;
 await deleteWritingReference(scope, referenceId!); return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }); } catch (error) { return writingFailure(error); }
}

import { writingRouteScope, writingResponse, writingFailure, type WritingRouteContext } from "@/lib/studio-writing-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { writingReferenceContent } from "@/lib/studio-writing";
export async function GET(request: Request, context: WritingRouteContext) {
 try { const scope = await writingRouteScope(request, context, false, true); const { referenceId } = await context.params;
 const content = await writingReferenceContent(scope, referenceId!);
 return new Response(new Uint8Array(content.bytes), { headers: { "Content-Type": content.mimeType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } }); } catch (error) { return writingFailure(error); }
}

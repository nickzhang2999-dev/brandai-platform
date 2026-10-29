import { writingRouteScope, writingResponse, writingFailure, type WritingRouteContext } from "@/lib/studio-writing-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { z } from "zod";
import { writingMessages } from "@/lib/studio-writing";
export async function GET(request: Request, context: WritingRouteContext) {
 try { const scope = await writingRouteScope(request, context); const raw = new URL(request.url).searchParams.get("beforeId"); const before = raw === null ? undefined : z.string().min(1).max(128).parse(raw); return writingResponse(await writingMessages(scope, before)); } catch (error) { return writingFailure(error); }
}

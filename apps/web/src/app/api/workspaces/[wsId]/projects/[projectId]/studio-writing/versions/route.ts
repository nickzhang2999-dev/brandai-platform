import { writingRouteScope, writingResponse, writingFailure, type WritingRouteContext } from "@/lib/studio-writing-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import { z } from "zod";
import { writingVersions } from "@/lib/studio-writing";
export async function GET(request: Request, context: WritingRouteContext) {
 try { const scope = await writingRouteScope(request, context); const raw = new URL(request.url).searchParams.get("beforeRevision"); const before = raw === null ? undefined : z.coerce.number().int().min(1).max(2 ** 31 - 1).parse(raw); return writingResponse(await writingVersions(scope, before)); } catch (error) { return writingFailure(error); }
}

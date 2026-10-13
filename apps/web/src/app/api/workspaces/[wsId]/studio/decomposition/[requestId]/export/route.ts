import { z } from "zod";
import { ApiException, handleError, requireUser } from "@/lib/api";
import { exportStudioDecompositionPsd } from "@/lib/studio-psd-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const query = z.object({ projectId: id, workspaceId: id.optional(), format: z.literal("psd").default("psd") }).strict();

export async function GET(req: Request, { params }: { params: Promise<{ wsId: string; requestId: string }> }) {
  try {
    const user = await requireUser();
    const { wsId, requestId } = await params;
    const search = new URL(req.url).searchParams;
    if ([...search.keys()].some(key => search.getAll(key).length !== 1)) throw new ApiException(422, "PSD 下载参数不能重复。");
    const input = query.parse(Object.fromEntries(search));
    if (input.workspaceId !== undefined && input.workspaceId !== wsId) throw new ApiException(404, "品牌作用域不一致。");
    const output = await exportStudioDecompositionPsd(wsId, user.id, input.projectId, requestId, req.signal);
    return new Response(new Uint8Array(output.body), { headers: {
      "content-type": "image/vnd.adobe.photoshop", "content-disposition": `attachment; filename="${output.fileName}"`,
      "content-length": String(output.body.length), "cache-control": "private, no-store", "x-content-type-options": "nosniff",
    } });
  } catch (error) { return handleError(error); }
}

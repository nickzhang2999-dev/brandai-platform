import { ZodError } from "zod";
import { requireUser, ApiException } from "@/lib/api";
import { isWorkbenchSameOrigin } from "@/lib/workbench-origin";
import { readWorkbenchJson } from "@/lib/workbench-request";
import { isDeepFlareV2Enabled } from "./feature";
import { WorkOrderConflict } from "./domain";
import { V2AccessError, createWorkOrder, readWorkOrder, commandWorkOrder } from "./service";

export type V2RouteContext = { params: Promise<{ wsId: string; projectId: string; workOrderId?: string }> };
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

export async function handleV2WorkOrder(req: Request, context: V2RouteContext) {
  try {
    const { wsId, projectId, workOrderId } = await context.params;
    if (!isDeepFlareV2Enabled(wsId)) return json({ error: "Not found" }, 404);
    const user = await requireUser();
    const expectedUser = req.headers.get("X-Novart-User");
    if (expectedUser !== null && expectedUser !== user.id) throw new V2AccessError(409, "账号已切换，请刷新");
    if (req.method !== "GET" && !isWorkbenchSameOrigin(req)) throw new V2AccessError(403, "Cross-origin write rejected");
    const scope = { workspaceId: wsId, projectId };
    if (req.method === "GET" && workOrderId) return json(await readWorkOrder(scope, user.id, workOrderId));
    const body = await readWorkbenchJson(req, 64 * 1024);
    if (req.method === "POST" && !workOrderId) return json(await createWorkOrder(scope, user.id, body), 201);
    if (req.method === "PATCH" && workOrderId) return json(await commandWorkOrder(scope, user.id, workOrderId, body));
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    if (error instanceof V2AccessError || error instanceof ApiException) return json({ error: error.message }, error.status);
    if (error instanceof WorkOrderConflict) return json({ error: error.message }, 409);
    if (error instanceof ZodError) return json({ error: "工作单输入格式不正确" }, 422);
    const requestId = crypto.randomUUID();
    console.error("[deepflare-v2]", { requestId, error });
    return json({ error: "工作单暂时不可用", requestId }, 503);
  }
}

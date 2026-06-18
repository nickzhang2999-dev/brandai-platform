import { PrecheckInput } from "@brandai/contracts";
import {
  ApiException,
  handleError,
  ok,
  parse,
  requireUser,
} from "@/lib/api";
import { requireOwnedWorkspace } from "@/lib/workspace";
import { runComplianceCheck } from "@/lib/compliance";

/**
 * M5 · 生成前合规预检 (the integration M3 depends on).
 *
 * POST /api/workspaces/[wsId]/compliance/precheck
 *   - body: frozen `PrecheckInput` ({ workspaceId, text })
 *   - returns: frozen `ComplianceCheckResponse` ({ results, report })
 *
 * `lib/precheck.ts` (M3, do-not-touch) self-calls this route:
 *   fetch(`${baseUrl}/api/workspaces/${workspaceId}/compliance/precheck`,
 *     { method: "POST", body: JSON.stringify({ workspaceId, text }) })
 *   then `ComplianceCheckResponse.parse(await res.json())`.
 * Keep this request/response contract exactly so the M3 wizard uses the
 * real endpoint instead of the direct-AI fallback.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);

    const input = parse(PrecheckInput, {
      ...(await req.json()),
      workspaceId: wsId,
    });
    if (input.workspaceId !== wsId) {
      throw new ApiException(400, "workspaceId mismatch");
    }

    const response = await runComplianceCheck({
      workspaceId: wsId,
      text: input.text,
    });
    return ok(response);
  } catch (err) {
    return handleError(err);
  }
}

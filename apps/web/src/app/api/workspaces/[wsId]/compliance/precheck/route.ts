import { PrecheckInput } from "@brandai/contracts";
import {
  ApiException,
  handleError,
  ok,
  parse,
  requireUser,
} from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { createComplianceTask } from "@/lib/compliance-tasks";

/** Accept a durable text check; the worker publishes the result on TaskState. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const input = parse(PrecheckInput, {
      ...(await req.json()),
      workspaceId: wsId,
    });
    if (input.workspaceId !== wsId) {
      throw new ApiException(400, "workspaceId mismatch");
    }

    const response = await createComplianceTask(wsId, "COMPLIANCE_PRECHECK", { userId: user.id, text: input.text });
    return ok(response, { status: 202 });
  } catch (err) {
    return handleError(err);
  }
}

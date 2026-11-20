import { DeepFlareV2State, GENERATION_ASPECT_RATIO_PRESETS, StudioGenerationInput } from "@brandai/contracts";
import { ZodError } from "zod";
import { Prisma, prisma } from "@brandai/db";
import { ApiException } from "../api";
import { acceptStudioGeneration } from "../studio-generation";
import { hashStudioPayload, requireStudioGenerationServices } from "../studio-generation-policy";
import { authorize, V2AccessError } from "./service";
import { nativeDispatchEnabled } from "./feature";

/** First milestone executes only the approved primary visual. Derived sizes have their own later approval. */
export function primaryInput(state: DeepFlareV2State, projectId: string, mutationId: string,
  workflowRevision: number, documentRevision: number) {
  if (state.status !== "READY" || state.approvedPlanVersion !== state.planVersion)
    throw new ApiException(409, "PLAN_NOT_APPROVED");
  // Direct work needs evidence of an approved template. Protocol v1 cannot express that yet.
  if (state.brief.mode === "DIRECT" || !state.direction)
    throw new ApiException(422, "APPROVED_DIRECTION_REQUIRED");
  if (state.brief.inspiration.length) throw new ApiException(422, "INSPIRATION_NOT_RESOLVED");
  const target = state.brief.deliverables[0]!;
  const prompt = [state.brief.text, target.channel, state.direction?.summary, state.direction?.composition].filter(Boolean).join("\n");
  for (const preset of GENERATION_ASPECT_RATIO_PRESETS) {
    for (const tier of ["1K", "2K"] as const) {
      const size = preset.sizes[tier];
      if (target.width !== size.width || target.height !== size.height) continue;
      const result = StudioGenerationInput.safeParse({ projectId, mutationId, prompt, workflowRevision,
        documentRevision, sizeSelection: { ratioKey: preset.key, resolutionTier: tier } });
      if (!result.success) throw new ApiException(422, "INVALID_NATIVE_INPUT");
      return result.data;
    }
  }
  throw new ApiException(422, "UNSUPPORTED_PRIMARY_SIZE");
}

/** One intake per tick. Everything billable is downstream of the committed native request. */
export async function dispatchSolPrimary() {
  const workspaces = (process.env.DEEPFLARE_V2_WORKSPACE_IDS ?? "").split(",").map(id => id.trim()).filter(id => id && nativeDispatchEnabled(id));
  if (!workspaces.length) return;
  const candidate = await prisma.deepFlareWorkOrderDispatch.findFirst({
    where: { status: "QUEUED", nextAttemptAt: { lte: new Date() }, workOrder: { workspaceId: { in: workspaces } } },
    select: { id: true }, orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
  });
  if (!candidate) return;
  try {
    await requireStudioGenerationServices();
    await prisma.$transaction(async tx => {
      // SKIP LOCKED lets concurrent consumers yield. Rollback restores both the handoff and quota.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "DeepFlareWorkOrderDispatch"
        WHERE id = ${candidate.id} AND status = 'QUEUED' AND "nextAttemptAt" <= clock_timestamp() FOR UPDATE SKIP LOCKED`;
      if (!locked.length) return;
      const row = await tx.deepFlareWorkOrderDispatch.findUniqueOrThrow({ where: candidate, include: { workOrder: true } });
      const { workspaceId, projectId } = row.workOrder;
      if (!nativeDispatchEnabled(workspaceId)) return;
      if (!row.actorId || !row.executionKey || row.workflowRevision === null || row.documentRevision === null)
        throw new ApiException(422, "INVALID_HANDOFF");
      await authorize(tx, { workspaceId, projectId }, row.actorId, true);
      const plan = DeepFlareV2State.parse(row.snapshot);
      if (row.planVersion !== plan.planVersion || row.workOrder.revision !== plan.revision)
        throw new ApiException(409, "PLAN_CHANGED");
      const input = primaryInput(plan, projectId, row.executionKey, row.workflowRevision, row.documentRevision);
      // One active Sol request across the pilot. Serializable isolation covers concurrent intake.
      const active = await tx.$queryRaw<{ id: string }[]>`SELECT r.id FROM "StudioGenerationRequest" r
        JOIN "DeepFlareWorkOrderDispatch" d ON d."nativeRequestId" = r.id
        WHERE r.status IN ('PENDING','RUNNING') LIMIT 1`;
      if (active.length) throw new ApiException(429, "SOL_CAPACITY");
      const identity = { workspaceId, userId: row.actorId, projectId, mutationId: row.executionKey };
      const native = await acceptStudioGeneration(tx, identity, input, hashStudioPayload(input));
      await tx.deepFlareWorkOrderDispatch.update({ where: candidate,
        data: { status: "LINKED", nativeRequestId: native.id, failureCode: null } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
    // Ordinary Studio outbox recovery owns Redis delivery, including after a process restart.
  } catch (error) {
    const code = error instanceof ApiException || error instanceof V2AccessError ? error.status : error instanceof ZodError ? 422 : null;
    const terminal = code !== null && [400, 402, 403, 404, 409, 422].includes(code);
    const knownReason = error instanceof ApiException && /^[A-Z_]+$/.test(error.message) ? error.message : null;
    await prisma.deepFlareWorkOrderDispatch.updateMany({ where: { ...candidate, status: "QUEUED" },
      data: { status: terminal ? "BLOCKED" : "QUEUED", failureCode: knownReason ?? (code ? `STUDIO_${code}` : "INTAKE_UNAVAILABLE"),
        nextAttemptAt: new Date(Date.now() + 30_000) } });
  }
}

import { StudioEditResponse, STUDIO_IMAGE_RECEIPT_RECOVERY_MS } from "@brandai/contracts";
import { prisma } from "@brandai/db";
import { decryptSecret, encryptSecret } from "./crypto";
import { readSubmittedStudioImage } from "./ai";
import { requireArtifactWrite, ensureStudioGenerationArtifacts } from "./studio-generation-artifacts";
import { stageStudioGenerationOutput, type StudioRequest } from "./studio-generation-lifecycle";
import { studioProviderParams } from "./studio-generation-references";
import { studioImageToolPixelEvidence } from "./studio-layer-repair";
import { fromGenerateUsage, recordUsage } from "./usage";
import type { GenerateJobData } from "./workers/generate.worker";

function checkpointIdentity(request: StudioRequest) {
  return JSON.stringify([request.id, request.workspaceId, request.projectId, request.userId, request.generationId,
    request.contextHash, request.providerStartedAt?.getTime(), request.expiresAt.getTime()]);
}

/** Bind recovery to this accepted task, endpoint and exact archive recipe. */
export async function saveStudioImageCheckpoint(request: StudioRequest, base: string, key: string,
  params: Record<string, unknown>, ownerId?: string) {
  if (!request.providerStartedAt) throw new Error("Generation has no active lease");
  const checkpoint = encryptSecret(JSON.stringify({ identity: checkpointIdentity(request), base, key, params, ownerId }));
  const changed = await prisma.studioGenerationRequest.updateMany({ where: { id: request.id, generationId: request.generationId,
    workspaceId: request.workspaceId, projectId: request.projectId, userId: request.userId, contextHash: request.contextHash,
    status: "RUNNING", providerStartedAt: request.providerStartedAt, receiptCheckpoint: null, expiresAt: { equals: request.expiresAt, gt: new Date() } },
    data: { receiptCheckpoint: checkpoint } });
  if (!changed.count) throw new Error("Generation is already submitted or no longer writable");
}

export function studioReceiptOutputParams(params: Record<string, unknown>, job: GenerateJobData, raw: Record<string, unknown>) {
  const tool = job.studioImageTool;
  const width = raw.providerWidth, height = raw.providerHeight;
  return { ...studioProviderParams(raw), ...params,
    ...(tool && job.studioEdit ? studioImageToolPixelEvidence(tool.operation, raw, job.studioEdit.width, job.studioEdit.height) : {}),
    ...(tool && Number.isSafeInteger(width) && Number.isSafeInteger(height)
      && Number(width) > 0 && Number(height) > 0 && Number(width) <= 8192 && Number(height) <= 8192
      ? { imageToolProviderSize: { width, height } } : {}),
  };
}

/** Redelivery never re-enters precheck or generation. Only the conditional
 * stage transaction may accept a single image, including when two readers race. */
export async function recoverSubmittedGeneration(request: StudioRequest) {
  const deadline = request.expiresAt.getTime() + STUDIO_IMAGE_RECEIPT_RECOVERY_MS;
  if (request.status !== "RUNNING" || !request.providerStartedAt || !request.receiptCheckpoint || deadline <= Date.now()) return;
  const ticket = JSON.parse(decryptSecret(request.receiptCheckpoint));
  if (ticket.identity !== checkpointIdentity(request)) throw new Error("Generation receipt identity changed");
  await prisma.$transaction(tx => requireArtifactWrite(tx, request.workspaceId, request.projectId, request.userId));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  const result = StudioEditResponse.parse(await readSubmittedStudioImage(ticket.base, request.id, ticket.key, AbortSignal.timeout(remaining)));
  const image = result.versions[0]!;
  await stageStudioGenerationOutput(request, { imageUrl: image.imageUrl, width: image.width, height: image.height,
    params: studioReceiptOutputParams(ticket.params, request.jobData as unknown as GenerateJobData, image.params) }, 0, request.receiptCheckpoint);
  await Promise.all([
    ensureStudioGenerationArtifacts(request.id),
    recordUsage({ workspaceId: request.workspaceId, userId: ticket.ownerId, generationId: request.generationId,
      kind: "GENERATE", status: "SUCCEEDED", ...fromGenerateUsage(result.usage) }),
  ]);
}

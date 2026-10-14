import { prisma } from "@brandai/db";
import { StudioImageToolInput, StudioImageToolSpec, StudioImageToolCapabilities, StudioConversationPixels,
  STUDIO_IMAGE_TOOLS_REVISION, STUDIO_IMAGE_TOOL_MASK_MAX_BYTES, STUDIO_IMAGE_TOOL_MAX_PIXELS } from "@brandai/contracts";
import { ApiException } from "./api";
import { getEffectiveAiSettings, getEffectiveStorage } from "./settings";
import { requireStudioMaterialProject } from "./studio-materials";
import { resolveStudioEditSource } from "./studio-generation-edit";
import { requireTrustedStudioBrandProjectMaterial } from "./studio-brand-materials";
import { hashStudioPayload, type StudioConversationAcceptance } from "./studio-generation-policy";
import { submitStudioGeneration, readStudioGeneration } from "./studio-generation";
import { requireArtifactWrite } from "./studio-generation-artifacts";

/** No key or provider URL is returned. Unverified adapters remain unavailable. */
export async function studioImageToolCapabilities() {
  const [settings, storage] = await Promise.all([getEffectiveAiSettings(), getEffectiveStorage()]);
  const provider = settings.image.provider.trim().toLowerCase(), model = settings.image.model.trim().toLowerCase();
  const supported = provider !== "mock" && !!settings.image.apiKey.trim() && /^gpt-image-2(?:[.-]|$)/.test(model);
  const baseReason = !supported ? "真实图片编辑模型尚未配置，图片工具不会调用演示服务。" : !storage.configured ? "对象存储未配置，暂时无法保存工具结果。" : null;
  const enabled = process.env.STUDIO_IMAGE_TOOLS_ENABLED === "1";
  const feature = (name: string) => {
    const available = !baseReason && enabled && process.env[name] === "1";
    return { available, reason: available ? null : baseReason ?? "该图片工具的提供者能力尚未验收启用；原图和编辑器仍可继续使用。" };
  };
  return StudioImageToolCapabilities.parse({ revision: STUDIO_IMAGE_TOOLS_REVISION,
    removeBackground: feature("STUDIO_BACKGROUND_REMOVAL_ENABLED"), inpaint: feature("STUDIO_INPAINT_ENABLED"),
    maskConvention: "white-edit-black-preserve", maxMaskBytes: STUDIO_IMAGE_TOOL_MASK_MAX_BYTES, maxPixels: STUDIO_IMAGE_TOOL_MAX_PIXELS });
}

/** Cheap intake check; full PNG decode and painted-region validation run in AI. */
export function assertStudioToolMaskHeader(mask: string, width: number, height: number) {
  const body = Buffer.from(mask.slice(mask.indexOf(",") + 1), "base64");
  if (body.length > STUDIO_IMAGE_TOOL_MASK_MAX_BYTES || body.length < 33 || !body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    || body.readUInt32BE(8) !== 13 || body.subarray(12,16).toString("ascii") !== "IHDR" || body.readUInt32BE(16) !== width || body.readUInt32BE(20) !== height) {
    throw new ApiException(422, "蒙版必须是与原图像素尺寸一致的 PNG；请重新绘制擦除区域。");
  }
}

/** Reuses generation quota, stable mutation identity, durable outbox and archive.
 * Only this authenticated intake may create the private imageTool acceptance. */
export async function submitStudioImageTool(workspaceId: string, userId: string, raw: unknown) {
  const input = StudioImageToolInput.parse(raw);
  await requireStudioMaterialProject(workspaceId, userId, input.projectId, true);
  const inputHash = hashStudioPayload(input);
  const existing = await prisma.studioGenerationRequest.findUnique({ where: { workspaceId_userId_projectId_mutationId: {
    workspaceId, userId, projectId: input.projectId, mutationId: input.mutationId } } });
  if (existing) {
    const job = existing.jobData as Record<string, unknown>;
    if (job.studioImageToolInputHash !== inputHash) throw new ApiException(409, "本次工具请求标识已用于其他内容，未重复调用模型。");
    return readStudioGeneration(workspaceId, userId, { projectId: input.projectId, requestId: existing.id });
  }
  const capabilities = await studioImageToolCapabilities();
  const capability = input.operation === "remove-background" ? capabilities.removeBackground : capabilities.inpaint;
  if (!capability.available) throw new ApiException(503, capability.reason!);
  const imageTool = StudioImageToolSpec.parse({ operation: input.operation, ...(input.mask ? { mask: input.mask } : {}) });
  const prompt = input.instruction ?? (input.operation === "remove-background"
    ? "移除背景，保留原有前景主体的形状、文字、颜色与细节，输出透明背景 PNG。"
    : "擦除蒙版白色区域中的对象，按周围环境自然修复背景；保留蒙版黑色区域的原始像素。");
  const sizeSelection = { ratioKey: "1:1" as const, resolutionTier: "1K" as const };
  const accepted = await prisma.$transaction(async tx => {
    await requireArtifactWrite(tx, workspaceId, input.projectId, userId);
    const [document, state] = await Promise.all([
      tx.editorDocument.findUnique({ where: { projectId: input.projectId } }),
      tx.workbenchProjectState.findUnique({ where: { projectId: input.projectId } }),
    ]);
    if (!document || document.workspaceId !== workspaceId || state && state.workspaceId !== workspaceId || document.revision !== input.documentRevision || (state?.workflowRevision ?? 0) !== input.workflowRevision) throw new ApiException(409, "画布或素材已变更，请先保存最新画布再操作图片。");
    const source = await resolveStudioEditSource(tx, workspaceId, input.projectId, input.target, document.canvas, true);
    const snapshot = source.snapshot;
    const material = await requireTrustedStudioBrandProjectMaterial(tx, workspaceId, input.projectId, snapshot.assetId, snapshot.sha256);
    const requestedSize = StudioConversationPixels.parse({ width: snapshot.width, height: snapshot.height });
    if (input.mask) assertStudioToolMaskHeader(input.mask, snapshot.width, snapshot.height);
    const referenceId = "tool-target";
    return { canvas: document.canvas, imageTool, imageToolInputHash: inputHash,
      references: [{ referenceId, name: material.fileName, shapeId: snapshot.shapeId, assetId: snapshot.assetId,
        assetSha256: snapshot.sha256, width: snapshot.width, height: snapshot.height, purpose: "REFERENCE" as const }],
      intent: { action: "modify" as const, targetReferenceId: referenceId, referenceIds: [], prompt, clarification: null,
        requestedSize, sizeSource: "target" as const, sizeSelection, parser: "safe-rules-v1" as const },
    } satisfies StudioConversationAcceptance;
  }, { timeout: 10_000 });
  return submitStudioGeneration(workspaceId, userId, { projectId: input.projectId, mutationId: input.mutationId, prompt,
    sizeSelection, documentRevision: input.documentRevision, workflowRevision: input.workflowRevision }, accepted);
}

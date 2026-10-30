import sharp from "sharp";
import { prisma } from "@brandai/db";
import { StudioConversationThumbnail, type StudioConversationInput, type StudioConversationModelRequest } from "@brandai/contracts";
import { readArtifactImageBytes, inspectArtifactImage, artifactDeadline, STUDIO_ARTIFACT_MAX_PIXELS } from "./studio-generation-artifacts-image";
import { ApiException } from "./api";

export type ConversationVisualContext = Pick<Extract<StudioConversationModelRequest, { schemaVersion: 2 }>, "references" | "history" | "selectedReferenceIds" | "lastResultImage" | "projectContext">;

/** Resolve images on the server through current project links. The browser
 * cannot supply a URL, thumbnail or conversation transcript to the planner. */
export async function loadStudioConversationContext(workspaceId: string, projectId: string, conversationId: string, before: Date,
  input: StudioConversationInput, signal: AbortSignal): Promise<ConversationVisualContext> {
  const rows = await prisma.studioConversationMessage.findMany({ where: { conversationId, conversation: { workspaceId, projectId }, createdAt: { lt: before } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 3, select: { text: true, intent: true, status: true, generationRequestId: true } });
  const requests = rows.flatMap(row => row.generationRequestId ? [row.generationRequestId] : []);
  const results = requests.length ? await prisma.studioGeneratedMaterial.findMany({ where: { requestId: { in: requests }, workspaceId, projectId, status: "SUCCEEDED",
    request: { workspaceId, projectId, status: "SUCCEEDED" }, asset: { workspaceId, availableForGeneration: true, deprecatedAt: null, projectLinks: { some: { projectId, project: { workspaceId } } } } },
    select: { requestId: true, assetId: true, sha256: true }, orderBy: { createdAt: "desc" }, take: 24 }) : [];
  const history: ConversationVisualContext["history"] = [];
  for (const row of [...rows].reverse()) {
    const result = results.filter(item => item.requestId === row.generationRequestId);
    const ref = result.length === 1 ? input.references.find(item => item.assetId === result[0]!.assetId) : undefined;
    const intent = row.intent as { action?: string; clarification?: string } | null;
    history.push({ role: "user", text: row.text.slice(0, 1000), resultReferenceId: null });
    history.push({ role: "assistant", text: (result.length ? `已完成${result.length}张图片。${intent?.action === "modify" ? "修改" : "生成"}结果。`
      : intent?.clarification || `任务状态：${row.status}，尚无已保存的结果。`).slice(0, 1000), resultReferenceId: ref?.referenceId ?? null });
  }
  // A prior result outside the current references is visual context only.
  // It has no editable reference ID and cannot silently become a target.
  const latest = rows.map(row => results.filter(item => item.requestId === row.generationRequestId)).find(items => items.length === 1)?.[0];
  const extra = latest?.assetId && latest.sha256 && !input.references.some(ref => ref.assetId === latest.assetId) ? latest : undefined;
  const priority = [input.quickEditTargetId, ...(input.selectedReferenceIds ?? []), ...input.references.map(ref => ref.referenceId)];
  const selected = [...new Set(priority.filter((id): id is string => !!id))].slice(0, extra ? 3 : 4);
  const assets = await prisma.asset.findMany({ where: { id: { in: [...input.references.filter(ref => selected.includes(ref.referenceId)).map(ref => ref.assetId), ...(extra?.assetId ? [extra.assetId] : [])] },
    workspaceId, deprecatedAt: null, availableForGeneration: true, projectLinks: { some: { projectId, project: { workspaceId } } } }, select: { id: true, url: true, storageKey: true } });
  let totalBytes = 0;
  const thumbnail = async (assetId: string, expectedHash: string) => {
    const asset = assets.find(item => item.id === assetId);
    if (!asset) throw new ApiException(422, "用于理解需求的图片已失效，请重新选择图片。");
    const bytes = await readArtifactImageBytes({ imageUrl: asset.url, objectKey: asset.storageKey && !/^https?:/i.test(asset.storageKey) ? asset.storageKey : null }, signal);
    totalBytes += bytes.length;
    if (totalBytes > 32 * 1024 * 1024) throw new ApiException(422, "参考图片总量过大，请减少图片后发送。");
    const meta = await inspectArtifactImage(bytes, signal);
    if (meta.sha256 !== expectedHash) throw new ApiException(422, "图片内容已改变，请重新选择后发送。");
    const image = sharp(bytes, { limitInputPixels: STUDIO_ARTIFACT_MAX_PIXELS, failOn: "warning" }).rotate().resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 65 });
    const abort = () => image.destroy(); signal.addEventListener("abort", abort, { once: true });
    try {
      const resized = await artifactDeadline(image.toBuffer({ resolveWithObject: true }), signal);
      return StudioConversationThumbnail.parse({ dataUrl: `data:image/jpeg;base64,${resized.data.toString("base64")}`, width: resized.info.width, height: resized.info.height });
    } finally { signal.removeEventListener("abort", abort); image.destroy(); }
  };
  const references: ConversationVisualContext["references"] = [];
  for (const ref of input.references) references.push({ referenceId: ref.referenceId, name: ref.name, editable: !!ref.shapeId,
    ...(selected.includes(ref.referenceId) ? { thumbnail: await thumbnail(ref.assetId, ref.assetSha256) } : {}) });
  return { references, history, selectedReferenceIds: input.selectedReferenceIds ?? [],
    ...(extra?.assetId && extra.sha256 ? { lastResultImage: { name: "上一张已保存结果（仅供理解上下文）", thumbnail: await thumbnail(extra.assetId, extra.sha256) } } : {}) };
}

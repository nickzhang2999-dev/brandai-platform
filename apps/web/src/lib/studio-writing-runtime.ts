import { createHash } from "node:crypto";
import { prisma } from "@brandai/db";
import { z } from "zod";
import sharp from "sharp";
import { StudioWritingParseRequest, StudioWritingParseResponse, StudioWritingResult, StudioWritingSegment } from "@brandai/contracts";
import { ApiException } from "./api";
import { resolveAiService } from "./ai-service";
import { artifactDeadline, inspectArtifactImage, readArtifactImageBytes, STUDIO_ARTIFACT_MAX_PIXELS } from "./studio-generation-artifacts-image";
import { WRITING_KIND, WRITING_EXPIRED, requireWritingScope, requireWritingAsset, writingJson, type WritingInput, type WritingScope } from "./studio-writing";
import { generateStudioWriting, type WritingProviderContext, type WritingSource } from "./studio-writing-provider";
import { recordUsage } from "./usage";

export async function parseWritingFile(input: z.infer<typeof StudioWritingParseRequest>, signal: AbortSignal) {
  const resolution = await artifactDeadline(resolveAiService({ requireStudioWritingParser: true }), signal);
  const response = await fetch(resolution.base + "/v1/studio-writing/parse", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(StudioWritingParseRequest.parse(input)), signal, redirect: "error" });
  if (!response.body) throw new ApiException(502, "文本解析服务没有返回结果。");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length;
      if (size > 1024 * 1024) throw new ApiException(502, "解析结果超过限制。"); chunks.push(value); }
    let data: unknown; try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ApiException(502, "文本解析服务响应无效。"); }
    if (!response.ok) {
      const code = (data as { detail?: { code?: string } })?.detail?.code;
      throw new ApiException(422, code === "no_extractable_text_no_ocr" ? "未找到可提取文字，可能是扫描件或纯图片；本次没有执行 OCR，请提供文字版。"
        : code === "encrypted_document" ? "文件已加密，请提供可读取的副本。"
        : code === "text_requires_utf8" ? "TXT/MD 需要 UTF-8 编码，请另存后上传。"
        : code === "parse_timeout" || code === "parse_resource_limit" ? "文件解析超过时间或资源限制，请拆分文件。"
        : code === "parse_busy" ? "文件解析服务繁忙，请稍后重新上传；系统没有调用模型。"
        : "文件格式、页数或解压大小不符合解析范围，请检查文件后重试。");
    }
    return StudioWritingParseResponse.parse(data);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Bounded lexical retrieval, with page/segment provenance preserved. No paid
 * embeddings or unsupported assertion that the entire file was model-read. */
export function selectWritingSegments(original: z.infer<typeof StudioWritingSegment>[], query: string, budget: number) {
  const tokens = new Set((query.toLowerCase().match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,}/g) ?? []).flatMap(word =>
    /^[\u3400-\u9fff]+$/.test(word) ? Array.from({ length: Math.max(1, word.length - 1) }, (_, i) => word.slice(i, i + 2)) : [word]).slice(0, 200));
  const ranked = original.map((segment, index) => ({ segment, index, score: [...tokens].reduce((sum, token) => sum + (segment.text.toLowerCase().includes(token) ? 1 : 0), 0) }));
  const relevant = ranked.some(item => item.score > 0);
  if (relevant) ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: z.infer<typeof StudioWritingSegment>[] = [];
  for (const { segment } of ranked) {
    if (budget <= 0) break;
    let text = segment.text.slice(0, budget);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    if (!text) break;
    selected.push({ ...segment, text }); budget -= text.length;
  }
  return { segments: selected, selection: relevant ? "relevant-snippets" as const : "opening-snippets" as const,
    partial: selected.length < original.length || selected.some(segment => segment.text.length !== original.find(item => item.id === segment.id)!.text.length) };
}
export async function prepareWritingSources(s: WritingScope, input: WritingInput, signal: AbortSignal): Promise<WritingSource[]> {
  const selected = input.context!.references;
  const rows = await prisma.studioWritingReference.findMany({ where: { id: { in: selected.map(r => r.id) }, documentId: input.documentId, deletedAt: null, status: "READY" } });
  if (rows.length !== selected.length) throw new ApiException(409, "所选参考资料已被移除或尚未就绪。");
  const sources: WritingSource[] = []; let remaining = 40000, images = 0;
  for (const chosen of selected) {
    const row = rows.find(r => r.id === chosen.id)!;
    if (row.sha256 !== chosen.sha256) throw new ApiException(409, "参考资料版本已变化。");
    if (row.assetId) await artifactDeadline(requireWritingAsset(s, row.assetId), signal);
    const original = z.array(StudioWritingSegment).max(200).parse(row.segments);
    const request = input.request as { prompt?: string; selection?: { text: string } };
    const chosenText = selectWritingSegments(original, `${request.prompt ?? ""}\n${request.selection?.text ?? ""}`, Math.min(6000, Math.floor(40000 / Math.max(1, selected.length)), remaining));
    remaining -= chosenText.segments.reduce((sum, segment) => sum + segment.text.length, 0);
    const source: WritingSource = { id: row.id, name: row.name, segments: chosenText.segments, coverage: {
      selection: chosenText.selection, extractedSegments: original.length, sentSegments: chosenText.segments.length,
      partial: chosenText.partial, extractionTruncated: row.truncated } };
    if (row.kind === "IMAGE") {
      if (++images > 4 || !row.body) throw new ApiException(422, "每次最多四张已准备好的图片。");
      const bytes = Buffer.from(row.body);
      const meta = await inspectArtifactImage(bytes, signal);
      if (meta.sha256 !== chosen.sha256) throw new ApiException(409, "图片内容哈希校验失败。");
      const image = sharp(bytes, { limitInputPixels: STUDIO_ARTIFACT_MAX_PIXELS }).rotate().resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 75 });
      try { source.imageBase64 = (await artifactDeadline(image.toBuffer(), signal)).toString("base64"); } finally { image.destroy(); }
    }
    sources.push(source);
  }
  return sources;
}

type Dependencies = { generate?: typeof generateStudioWriting; parse?: typeof parseWritingFile };
export async function processWritingTask(taskId: string, dependencies: Dependencies = {}) {
  const task = await prisma.asyncTask.findUnique({ where: { id: taskId } });
  if (!task || task.kind !== WRITING_KIND || task.status !== "PENDING" || !task.refId || !task.expiresAt) return;
  const claimed = await prisma.asyncTask.updateMany({ where: { id: task.id, kind: WRITING_KIND, status: "PENDING", expiresAt: { gt: new Date() } }, data: { status: "RUNNING", progress: 10 } });
  if (!claimed.count) return;
  const input = task.inputJson as unknown as WritingInput;
  const scope = { workspaceId: task.workspaceId, projectId: task.refId, userId: input.userId };
  const controller = new AbortController(); const { signal } = controller;
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(input.operation === "REFERENCE_PARSE" ? 30_000 : 180_000, task.expiresAt.getTime() - Date.now())));
  try {
    await artifactDeadline(requireWritingScope(scope, true), signal);
    const document = await prisma.studioWritingDocument.findFirst({ where: { id: input.documentId, ...scope } });
    if (!document) throw new ApiException(404, "文案工作区已不存在。");
    let result: StudioWritingResult;
    let parsed: { referenceId: string; segments: z.infer<typeof StudioWritingSegment>[]; body: Uint8Array<ArrayBuffer>; mimeType: string; truncated: boolean; assetId: string | null } | null = null;
    if (input.operation === "REFERENCE_PARSE") {
      const reference = await prisma.studioWritingReference.findFirst({ where: { id: input.referenceId, documentId: document.id, taskId: task.id, deletedAt: null, status: "PENDING" } });
      if (!reference) throw new ApiException(404, "参考资料已移除或处理状态已变化。");
      await prisma.studioWritingReference.update({ where: { id: reference.id }, data: { status: "RUNNING" } });
      let bytes: Buffer | null = reference.body ? Buffer.from(reference.body) : null;
      if (reference.assetId) {
        const asset = await artifactDeadline(requireWritingAsset(scope, reference.assetId), signal);
        bytes = await readArtifactImageBytes({ imageUrl: asset.url, objectKey: asset.storageKey && !/^https?:/i.test(asset.storageKey) ? asset.storageKey : null }, signal);
      }
      if (!bytes?.length || bytes.length > 10 * 1024 * 1024) throw new ApiException(413, "资料内容为空或超过 10 MiB。");
      if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw new ApiException(409, "资料内容哈希校验失败，请重新选择。");
      let segments: z.infer<typeof StudioWritingSegment>[], mimeType = reference.mimeType, truncated = false;
      if (reference.kind === "IMAGE") {
        const meta = await inspectArtifactImage(bytes, signal);
        if (meta.sha256 !== reference.sha256) throw new ApiException(409, "图片内容已变化，请重新选择。");
        mimeType = meta.mimeType;
        segments = [{ id: "image-1", pageNumber: null, label: "所选图片", text: "图片已校验；生成时按需发送视觉参考，本步骤未执行 OCR。" }];
      } else {
        const output = await artifactDeadline((dependencies.parse ?? parseWritingFile)({ fileName: reference.name, mimeType: reference.mimeType, contentBase64: bytes.toString("base64") }, signal), signal);
        segments = output.segments; truncated = output.truncated;
      }
      parsed = { referenceId: reference.id, segments, body: new Uint8Array(bytes), mimeType, truncated, assetId: reference.assetId };
      result = { text: reference.kind === "IMAGE" ? "图片已准备完成，尚未调用模型。" : truncated ? "已提取有界文本片段；超出部分未读取，未执行 OCR。" : "文本片段已提取，未调用模型或执行 OCR。",
        scope: "REFERENCE", baseRevision: document.revision, citations: [], styleDraft: null, model: "none", inputTokens: 0, outputTokens: 0, latencyMs: 0 };
    } else {
      if (!input.context) throw new ApiException(422, "任务缺少已受理的上下文。");
      const [brand, project] = await Promise.all([
        prisma.brandWorkspace.findUniqueOrThrow({ where: { id: task.workspaceId }, select: { name: true } }),
        prisma.project.findFirstOrThrow({ where: { id: task.refId, workspaceId: task.workspaceId }, select: { name: true } }),
      ]);
      const sources = await prepareWritingSources(scope, input, signal);
      const context: WritingProviderContext = { input, brandName: brand.name, projectName: project.name, sources };
      result = StudioWritingResult.parse(await artifactDeadline((dependencies.generate ?? generateStudioWriting)(context, signal), signal));
      await recordUsage({ workspaceId: task.workspaceId, userId: input.userId, kind: WRITING_KIND, status: "SUCCEEDED", provider: "copywriting-config",
        model: result.model, totalTokens: result.inputTokens + result.outputTokens, latencyMs: result.latencyMs });
      // Revalidate ownership and removals after the paid call; never silently
      // republish text from a deleted reference or revoked workspace access.
      await artifactDeadline(requireWritingScope(scope, true), signal);
      const available = await prisma.studioWritingReference.findMany({ where: { id: { in: input.context.references.map(r => r.id) }, documentId: document.id, deletedAt: null, status: "READY" }, select: { id: true, sha256: true, assetId: true } });
      if (available.length !== input.context.references.length || available.some(row => input.context!.references.find(ref => ref.id === row.id)?.sha256 !== row.sha256)) throw new ApiException(409, "生成期间参考资料已移除或更新，结果未保存。");
      for (const row of available) if (row.assetId) await artifactDeadline(requireWritingAsset(scope, row.assetId), signal);
    }
    await artifactDeadline(requireWritingScope(scope, true), signal); signal.throwIfAborted();
    if (parsed?.assetId) await artifactDeadline(requireWritingAsset(scope, parsed.assetId), signal);
    if (result.text.includes("\0")) throw new ApiException(502, "模型返回无效字符。");
    await prisma.$transaction(async tx => {
      const changed = await tx.asyncTask.updateMany({ where: { id: task.id, kind: WRITING_KIND, status: "RUNNING", expiresAt: { gt: new Date() } },
        data: { status: "SUCCEEDED", progress: 100, resultJson: writingJson(result), error: null, refCount: result.citations.length } });
      if (!changed.count) throw new ApiException(409, WRITING_EXPIRED);
      if (parsed) {
        const row = await tx.studioWritingReference.updateMany({ where: { id: parsed.referenceId, documentId: document.id, taskId: task.id, deletedAt: null, status: "RUNNING" },
          data: { status: "READY", error: null, segments: parsed.segments, truncated: parsed.truncated, body: parsed.body, mimeType: parsed.mimeType, sizeBytes: parsed.body.length } });
        if (!row.count) throw new ApiException(409, "资料已移除，解析结果未保存。");
      }
      if (input.operation === "GENERATE") await tx.studioWritingMessage.create({ data: { documentId: document.id, taskId: task.id, role: "assistant", text: result.text, citations: writingJson(result.citations) } });
      // Deliberately no StudioWritingDocument/Version or Style mutation here.
    }, { maxWait: 1000, timeout: 1500 });
  } catch (error) {
    const message = signal.aborted ? WRITING_EXPIRED : error instanceof ApiException ? error.message : "任务未完成，请检查资料或稍后重试；系统不会自动重复调用模型。";
    await prisma.$transaction(async tx => {
      await tx.asyncTask.updateMany({ where: { id: task.id, kind: WRITING_KIND, status: "RUNNING" }, data: { status: "FAILED", error: message } });
      if (input.operation === "REFERENCE_PARSE") await tx.studioWritingReference.updateMany({ where: { taskId: task.id, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "FAILED", error: message, body: null } });
    });
  } finally { clearTimeout(timer); controller.abort(); }
}

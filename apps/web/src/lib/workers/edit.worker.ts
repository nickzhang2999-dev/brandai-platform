import { Worker, type Job } from "bullmq";
import { prisma, Prisma } from "@brandai/db";
import {
  EditOp,
  EditRequest,
  EditResponse,
} from "@brandai/contracts";
import { connection, queuePrefix } from "@/lib/queue";
import { ai } from "@/lib/ai";
import { recordUsage } from "@/lib/usage";
import { uploadDataUrlImage } from "@/lib/s3";
import { mirrorGenerationVersionToAsset } from "@/lib/asset-mirror";
import {
  markRunning,
  setProgress,
  markSucceeded,
  markFailed,
} from "@/lib/async-tasks";

/**
 * Payload enqueued by
 * POST /api/workspaces/[wsId]/generations/[genId]/versions/[versionId]/edit.
 * The BullMQ job id is what the client polls (no Job model — schema frozen —
 * same pattern as M2/M3). The source GenerationVersion is never overwritten;
 * a NEW child version is created with `parentVersionId` set to the source.
 */
export interface EditJobData {
  workspaceId: string;
  generationId: string;
  /** The source version this edit derives from. */
  sourceVersionId: string;
  op: EditOp;
  payload: Record<string, unknown>;
  /** H-async — server-authoritative task row to mirror progress/status into. */
  taskId?: string;
}

export interface EditJobResult {
  generationId: string;
  sourceVersionId: string;
  versionId: string;
}

/**
 * Consumes the `edit` queue: loads the source GenerationVersion, calls the
 * AI service `/v1/edit` (mock provider by default so this works with no API
 * keys), re-validates the response against the frozen `EditResponse`
 * contract, then persists a NEW GenerationVersion as a child of the source
 * (parentVersionId = source, new max(index)+1 within the generation, op +
 * payload + lineage recorded into `params`, complianceReport left null for
 * M5, isFinal=false). The original image is never mutated.
 */
export async function runEditJob(
  job: Job<EditJobData>,
): Promise<EditJobResult> {
  const { generationId, sourceVersionId, op, payload, taskId, workspaceId } =
    job.data;
  try {
  await job.updateProgress(5);
  await markRunning(taskId, 5);

  const source = await prisma.generationVersion.findUnique({
    where: { id: sourceVersionId },
  });
  if (!source || source.generationId !== generationId) {
    throw new Error(
      `Source version ${sourceVersionId} not found in generation ${generationId}`,
    );
  }
  await job.updateProgress(20);
  await setProgress(taskId, 20);

  const request = EditRequest.parse({
    imageUrl: source.imageUrl,
    op,
    payload,
  });
  // §2.3 — log every AI call's wall-clock latency for the activity log.
  const _t0 = Date.now();
  let raw: unknown;
  try {
    raw = await ai.edit(request);
  } catch (aiErr) {
    await recordUsage({
      workspaceId,
      kind: "EDIT",
      status: "FAILED",
      latencyMs: Date.now() - _t0,
    });
    throw aiErr;
  }
  // Re-validate AI output against the frozen contract before persisting.
  const result = EditResponse.parse(raw);
  await recordUsage({
    workspaceId,
    kind: "EDIT",
    status: "SUCCEEDED",
    imageCount: 1,
    latencyMs: Date.now() - _t0,
  });
  await job.updateProgress(70);

  // New index = max(index)+1 within the generation so ordering stays clean
  // and queryable; the original root version is never overwritten.
  const agg = await prisma.generationVersion.aggregate({
    where: { generationId },
    _max: { index: true },
  });
  const nextIndex = (agg._max.index ?? -1) + 1;

  const sourceParams =
    source.params && typeof source.params === "object"
      ? (source.params as Record<string, unknown>)
      : {};

  // 与 generate.worker 一致:真实 provider 返回的 b64 会被 AI 服务转成多 MB 的
  // data: URL。配了对象存储就上传换公网 URL,避免把大图塞进 Postgres/JSON 拖慢
  // project/version 读取;未配存储时透传 data: URL。
  const editedImageUrl = await uploadDataUrlImage(
    result.imageUrl,
    `generations/${workspaceId}`,
  );

  // 尺寸:仅当本次编辑显式指定了 width/height(RESIZE / OUTPAINT 等改变画布的操作
  // 会在 payload 里带上)才采用 AI 返回的尺寸;否则 RECOLOR/INPAINT/EDIT_TEXT 等
  // 不改尺寸的操作沿用源版本尺寸——AI /v1/edit 对无尺寸 payload 默认 1024×1024,
  // 直接采用会污染非正方形源的 lineage/导出标签/文字图层画布。
  const payloadObj =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const hasExplicitSize = "width" in payloadObj || "height" in payloadObj;
  const editedWidth = hasExplicitSize ? result.width : source.width;
  const editedHeight = hasExplicitSize ? result.height : source.height;

  const created = await prisma.generationVersion.create({
    data: {
      generationId,
      index: nextIndex,
      imageUrl: editedImageUrl,
      width: editedWidth,
      height: editedHeight,
      parentVersionId: source.id,
      isFinal: false,
      params: {
        // Carry forward the source params (applied rules / scene) then
        // record this edit so M6 can trace the lineage and what changed.
        ...sourceParams,
        ...result.params,
        edit: {
          op,
          payload,
          sourceVersionId: source.id,
          editedAt: new Date().toISOString(),
        },
      } as Prisma.InputJsonValue,
      // complianceReport left null for M5 to (re)fill on edited versions.
    },
  });

  // F18 · 出图回流素材库 — 改图子版本同样镜像成素材，使改图产物也进素材库。
  // sceneType 沿用源版本 params 里 generate.worker 盖的戳；best-effort，不阻断改图。
  await mirrorGenerationVersionToAsset({
    workspaceId,
    generationVersionId: created.id,
    imageUrl: editedImageUrl,
    dataUrl: result.imageUrl,
    width: editedWidth,
    height: editedHeight,
    sceneType:
      typeof sourceParams.sceneType === "string"
        ? sourceParams.sceneType
        : null,
    fileLabel: `改图_${op}_${nextIndex}`,
    aiDescription: `由出图改图生成（${op}）`,
  });

  await job.updateProgress(100);
  await markSucceeded(taskId, { refId: created.id, refCount: 1 });
  return {
    generationId,
    sourceVersionId: source.id,
    versionId: created.id,
  };
  } catch (err) {
    await markFailed(taskId, String(err));
    throw err;
  }
}

export function createEditWorker() {
  const worker = new Worker<EditJobData, EditJobResult>(
    "edit",
    runEditJob,
    { connection, prefix: queuePrefix, concurrency: 2 },
  );
  worker.on("failed", (job, err) => {
    console.error(`[edit] job ${job?.id} failed:`, err);
  });
  worker.on("completed", (job) => {
    console.log(`[edit] job ${job.id} completed`);
  });
  return worker;
}

import { Worker, type Job } from "bullmq";
import { prisma, Prisma } from "@brandai/db";
import {
  EditOp,
  EditRequest,
  EditResponse,
} from "@brandai/contracts";
import { connection } from "@/lib/queue";
import { ai } from "@/lib/ai";
import { recordUsage } from "@/lib/usage";
import { uploadDataUrlImage } from "@/lib/s3";
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

  const created = await prisma.generationVersion.create({
    data: {
      generationId,
      index: nextIndex,
      imageUrl: editedImageUrl,
      width: result.width,
      height: result.height,
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
    { connection, concurrency: 2 },
  );
  worker.on("failed", (job, err) => {
    console.error(`[edit] job ${job?.id} failed:`, err);
  });
  worker.on("completed", (job) => {
    console.log(`[edit] job ${job.id} completed`);
  });
  return worker;
}

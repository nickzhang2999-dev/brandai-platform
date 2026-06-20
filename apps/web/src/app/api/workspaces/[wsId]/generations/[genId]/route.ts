import { z } from "zod";
import { prisma } from "@brandai/db";
import { SizeSpec } from "@brandai/contracts";
import {
  ApiException,
  handleError,
  ok,
  parse,
  requireUser,
} from "@/lib/api";
import {
  requireOwnedWorkspace,
  getWorkspaceRole,
  requireWorkspaceRole,
} from "@/lib/workspace";
import { generateQueue } from "@/lib/queue";
import { getGeneration } from "@/lib/generations";
import type { GenerateJobData } from "@/lib/workers/generate.worker";

/**
 * GET    → { generation, job } — the contract-shaped Generation (with
 *          versions) plus the live BullMQ job state for progress polling.
 * POST   → 重新生成: re-enqueue a `generate` job for this generation
 *          (the worker replaces the prior root versions, keeping `index`
 *          clean). Returns the refreshed generation + new jobId.
 * PATCH  → 选择入库: mark one version as kept (isFinal=true) and
 *          un-mark its siblings, so the Project/Generation has a single
 *          selected deliverable. The rows already persist; this only
 *          flags the selection. M6 owns deeper version management.
 */

const JOB_STATE_MAP: Record<
  string,
  "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED"
> = {
  waiting: "PENDING",
  delayed: "PENDING",
  "waiting-children": "PENDING",
  prioritized: "PENDING",
  active: "RUNNING",
  completed: "SUCCEEDED",
  failed: "FAILED",
};

async function loadOwned(
  wsId: string,
  genId: string,
  userId: string,
) {
  await requireOwnedWorkspace(wsId, userId);
  const row = await prisma.generation.findUnique({
    where: { id: genId },
  });
  if (!row || row.workspaceId !== wsId) {
    throw new ApiException(404, "Generation not found");
  }
  return row;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ wsId: string; genId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, genId } = await params;
    await loadOwned(wsId, genId, user.id);

    const generation = await getGeneration(genId);
    const jobId = new URL(req.url).searchParams.get("jobId");

    let job:
      | {
          jobId: string;
          status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
          progress: number;
          failedReason?: string;
        }
      | undefined;
    if (jobId) {
      const j = await generateQueue.getJob(jobId);
      if (j && (j.data as GenerateJobData)?.generationId === genId) {
        const state = await j.getState();
        const status = JOB_STATE_MAP[state] ?? "PENDING";
        job = {
          jobId: String(j.id),
          status,
          progress: typeof j.progress === "number" ? j.progress : 0,
          failedReason:
            status === "FAILED" ? j.failedReason : undefined,
        };
      }
    }

    return ok({ generation, job });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * P2.0 — optional re-generate body. When `targets` is provided the re-run is
 * multi-size (e.g. "retry just the one failed size"). Without a body the
 * legacy whole-generation re-run is used (count = prior root versions).
 */
const RegenerateInput = z
  .object({
    targets: z.array(SizeSpec).optional(),
  })
  .optional();

export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string; genId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, genId } = await params;
    await loadOwned(wsId, genId, user.id);
    // G6 — 重新生成属于内容写操作:编辑+(EDITOR/OWNER)。
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    // Body is optional; tolerate an empty request.
    let body: z.infer<typeof RegenerateInput> = undefined;
    try {
      const raw = await req.text();
      if (raw.trim().length > 0) body = parse(RegenerateInput, JSON.parse(raw));
    } catch {
      body = undefined;
    }

    // 原子抢占:只把"终态(SUCCEEDED/FAILED)"的行翻成 PENDING。两个并发 POST 中
    // 只有一个能命中(count===1),另一个 count===0 → 409。避免先读 status 再写的
    // TOCTOU 让两个 generate job 并发跑同一 generationId、互相覆盖删旧/写终态。
    // 重新锚定 stale 计时:sweepStaleGenerations 按 createdAt < cutoff(10min)把
    // PENDING/RUNNING 判为"丢失"。重生成一个 10 分钟前创建的 generation 若不刷新
    // createdAt,会被下一次 sweep 立刻误杀为 FAILED(并放行再次重试,与仍在跑的
    // 本次 job 撞车)。这里把 createdAt 重置为现在、清空上一轮 started/finished。
    const now = new Date();
    const claimed = await prisma.generation.updateMany({
      where: { id: genId, status: { in: ["SUCCEEDED", "FAILED"] } },
      data: {
        status: "PENDING",
        error: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
      },
    });
    if (claimed.count !== 1) {
      throw new ApiException(409, "该生成任务进行中,请等待完成后再重试");
    }

    // Schema (frozen) doesn't persist versionCount; preserve the original
    // request's intent by re-using the count of existing root versions.
    const priorRootVersions = await prisma.generationVersion.count({
      where: { generationId: genId, parentVersionId: null },
    });

    const jobData: GenerateJobData = {
      workspaceId: wsId,
      generationId: genId,
      versionCount: priorRootVersions > 0 ? priorRootVersions : 4,
      ...(body?.targets && body.targets.length > 0
        ? { targets: body.targets }
        : {}),
    };
    const job = await generateQueue.add("generate", jobData, {
      removeOnComplete: 50,
      removeOnFail: 50,
      // §2.4 — see POST /generations route for the rationale.
      attempts: 1,
    });

    const generation = await getGeneration(genId);
    return ok({ generation, jobId: job.id }, { status: 202 });
  } catch (err) {
    return handleError(err);
  }
}

const SelectVersionInput = z.object({
  versionId: z.string(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ wsId: string; genId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId, genId } = await params;
    await loadOwned(wsId, genId, user.id);

    const { versionId } = parse(SelectVersionInput, await req.json());
    const version = await prisma.generationVersion.findUnique({
      where: { id: versionId },
    });
    if (!version || version.generationId !== genId) {
      throw new ApiException(404, "Version not found in this generation");
    }

    // G6 — approval gate on 标最终(交付):
    //  - VIEWER(只读)一律不可标最终 → 403;
    //  - OWNER 可随时标最终(单人流程不变);
    //  - EDITOR/REVIEWER 仅可标"已审批通过(APPROVED)"的版本。
    const role = await getWorkspaceRole(wsId, user.id);
    const rank: Record<string, number> = {
      OWNER: 3,
      EDITOR: 2,
      REVIEWER: 1,
      VIEWER: 0,
    };
    if ((rank[role ?? ""] ?? -1) < 1) {
      throw new ApiException(403, "权限不足:查看角色不能标最终版");
    }
    if (role !== "OWNER" && version.reviewStatus !== "APPROVED") {
      throw new ApiException(
        422,
        "该版本需经审批通过(APPROVED)后才能标为最终版",
      );
    }

    // Single kept deliverable per generation: clear siblings, set this one.
    await prisma.$transaction([
      prisma.generationVersion.updateMany({
        where: { generationId: genId },
        data: { isFinal: false },
      }),
      prisma.generationVersion.update({
        where: { id: versionId },
        data: { isFinal: true },
      }),
    ]);

    return ok(await getGeneration(genId));
  } catch (err) {
    return handleError(err);
  }
}

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

    // 载入旧 root 版本:既复用数量,又**重建多尺寸 targets**——否则无 body 的整体
    // 重生成会丢掉原 targets,被 worker 当 versionCount 同尺寸路径跑、删光旧 root,
    // 把一整套渠道尺寸(banner/小红书封面/电商主图…)换成几张场景默认尺寸图。
    // 版本列 width/height 存的就是当初请求的目标尺寸,params.targetKey/Label 标识档位。
    const priorRoots = await prisma.generationVersion.findMany({
      where: { generationId: genId, parentVersionId: null },
      select: { width: true, height: true, params: true },
    });
    const reconstructedTargets = priorRoots
      .map((v) => {
        const p = (v.params ?? {}) as {
          targetKey?: unknown;
          targetLabel?: unknown;
        };
        if (typeof p.targetKey !== "string") return null;
        return {
          key: p.targetKey,
          label: typeof p.targetLabel === "string" ? p.targetLabel : p.targetKey,
          width: v.width,
          height: v.height,
        };
      })
      .filter((t): t is SizeSpec => t !== null);

    // 显式 body.targets(单尺寸重试)优先;否则用重建的多尺寸;都没有才走 versionCount。
    const targets =
      body?.targets && body.targets.length > 0
        ? body.targets
        : reconstructedTargets.length > 0
          ? reconstructedTargets
          : undefined;

    // F7 / F9 / L8 — reconstruct the original per-generation style keywords +
    // reference assets from the prior root versions' params (same approach as
    // targets above), so 重新生成 keeps the user's picks instead of dropping them.
    const reconstructedStyleKeywords = (() => {
      for (const v of priorRoots) {
        const p = (v.params ?? {}) as { styleKeywords?: unknown };
        if (
          Array.isArray(p.styleKeywords) &&
          p.styleKeywords.every((s) => typeof s === "string")
        ) {
          return p.styleKeywords as string[];
        }
      }
      return undefined;
    })();
    const reconstructedReferenceAssetIds = (() => {
      for (const v of priorRoots) {
        const p = (v.params ?? {}) as { referenceAssetIds?: unknown };
        if (
          Array.isArray(p.referenceAssetIds) &&
          p.referenceAssetIds.every((s) => typeof s === "string")
        ) {
          return p.referenceAssetIds as string[];
        }
      }
      return undefined;
    })();

    // K5 / M3 — reconstruct the chosen text mode from the prior root versions'
    // params (same approach as styleKeywords above), so 重新生成 keeps the
    // 直接出图 / 分层留白 选择 instead of silently reverting to "direct".
    const reconstructedTextMode = (() => {
      for (const v of priorRoots) {
        const p = (v.params ?? {}) as { textMode?: unknown };
        if (p.textMode === "direct" || p.textMode === "layered") {
          return p.textMode;
        }
      }
      return undefined;
    })();

    const jobData: GenerateJobData = {
      workspaceId: wsId,
      generationId: genId,
      versionCount: priorRoots.length > 0 ? priorRoots.length : 4,
      ...(targets ? { targets } : {}),
      ...(reconstructedTextMode ? { textMode: reconstructedTextMode } : {}),
      ...(reconstructedStyleKeywords && reconstructedStyleKeywords.length > 0
        ? { styleKeywords: reconstructedStyleKeywords }
        : {}),
      ...(reconstructedReferenceAssetIds &&
      reconstructedReferenceAssetIds.length > 0
        ? { referenceAssetIds: reconstructedReferenceAssetIds }
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

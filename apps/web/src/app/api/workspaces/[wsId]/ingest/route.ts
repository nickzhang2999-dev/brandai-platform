import { z } from "zod";
import { prisma } from "@brandai/db";
import { AssetCategory, IngestWebsiteInput } from "@brandai/contracts";
import { handleError, ok, parse, requireUser, ApiException } from "@/lib/api";
import { assertSafePublicUrl } from "@/lib/ssrf";
import { requireWorkspaceRole } from "@/lib/workspace";
import { ingestQueue } from "@/lib/queue";
import { createTask } from "@/lib/async-tasks";
import type {
  IngestJobData,
  IngestJobResult,
} from "@/lib/workers/ingest.worker";

/**
 * K3 / §2 — POST .../ingest enqueues a website ingest crawl and returns 202
 * with `{ jobId, taskId }`. The AI crawl is slow, so it MUST NOT be awaited in
 * this HTTP handler (the §2.1 "2-second response" rule). The client polls
 * GET .../ingest?jobId=... for status + the candidate images/copies/
 * sellingPoints (the job return value). SSRF validation on the URL happens here
 * before enqueue (fast, DB/network-free for private/local/metadata addresses).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");
    const input = parse(IngestWebsiteInput, {
      ...(await req.json()),
      workspaceId: wsId,
    });
    // SSRF 防护:这个 URL 会被 AI 服务端 httpx.get 抓取,先拒内网/本地/元数据地址。
    // 注:AI 侧 follow_redirects=True,跨站重定向到内网的残留风险需在 apps/ai 侧
    // 进一步加固(httpx 传输层拦私网 IP)。
    await assertSafePublicUrl(input.url);

    // H-async — server-authoritative task row so the ingest view is
    // refresh-resumable (`?task=`) with a real progress %.
    const task = await createTask({ workspaceId: wsId, kind: "INGEST" });
    const jobData: IngestJobData = {
      workspaceId: wsId,
      url: input.url,
      taskId: task.id,
    };
    const job = await ingestQueue.add("ingest", jobData, {
      removeOnComplete: 50,
      removeOnFail: 50,
      attempts: 1,
    });
    await prisma.asyncTask.update({
      where: { id: task.id },
      data: { jobId: job.id },
    });

    return ok(
      { jobId: job.id, taskId: task.id, status: "PENDING" as const },
      { status: 202 },
    );
  } catch (err) {
    return handleError(err);
  }
}

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

/**
 * GET .../ingest?jobId=... -> poll the ingest crawl. Returns the live status +,
 * once SUCCEEDED, the candidate `result` (images/copies/sellingPoints) for the
 * selectable grid. Workspace-scoped: a job for another workspace is 404.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const jobId = new URL(req.url).searchParams.get("jobId");
    if (!jobId) throw new ApiException(400, "jobId is required");

    const job = await ingestQueue.getJob(jobId);
    if (!job || (job.data as IngestJobData)?.workspaceId !== wsId) {
      throw new ApiException(404, "Job not found");
    }

    const state = await job.getState();
    const status = JOB_STATE_MAP[state] ?? "PENDING";
    return ok({
      jobId: job.id,
      status,
      progress: typeof job.progress === "number" ? job.progress : 0,
      result:
        status === "SUCCEEDED"
          ? (job.returnvalue as IngestJobResult | undefined)
          : undefined,
      failedReason: status === "FAILED" ? job.failedReason : undefined,
    });
  } catch (err) {
    return handleError(err);
  }
}

const SaveImage = z.object({
  sourceUrl: z.string(),
  previewUrl: z.string(),
  guessedCategory: z.string().optional(),
});
const SaveIngestedInput = z.object({
  images: z.array(SaveImage).min(1),
  category: AssetCategory.optional(),
});

function toCategory(guessed?: string): AssetCategory {
  const parsed = AssetCategory.safeParse(
    (guessed ?? "").toUpperCase(),
  );
  return parsed.success ? parsed.data : "OTHER";
}

/**
 * PUT .../ingest -> persist selected candidate images as WEBSITE assets.
 * previewUrl is stored as the asset url (no re-upload to S3 in P0).
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");
    const input = parse(SaveIngestedInput, await req.json());

    // SSRF 防护:previewUrl/sourceUrl 会被存为 asset.url/storageKey,之后
    // /assets/[id]/raw 会服务端 fetch 它们。落库前先拒绝内网/本地/元数据地址。
    for (const img of input.images) {
      await assertSafePublicUrl(img.previewUrl);
      await assertSafePublicUrl(img.sourceUrl);
    }

    const created = await prisma.$transaction(
      input.images.map((img) => {
        const fileName =
          img.sourceUrl.split("/").pop()?.split("?")[0] || "website-asset";
        return prisma.asset.create({
          data: {
            workspaceId: wsId,
            category: input.category ?? toCategory(img.guessedCategory),
            fileName,
            storageKey: img.sourceUrl,
            url: img.previewUrl,
            mimeType: "image/*",
            sizeBytes: 0,
            source: "WEBSITE",
          },
        });
      }),
    );
    return ok(created, { status: 201 });
  } catch (err) {
    return handleError(err);
  }
}

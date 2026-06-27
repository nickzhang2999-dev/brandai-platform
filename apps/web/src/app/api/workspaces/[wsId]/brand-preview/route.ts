import { prisma } from "@brandai/db";
import {
  ApiException,
  handleError,
  ok,
  requireUser,
} from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { generateQueue } from "@/lib/queue";
import { getGeneration } from "@/lib/generations";
import type { GenerateJobData } from "@/lib/workers/generate.worker";
import { getConfirmedRules } from "@/lib/rules";
import { reserveGenerationQuota } from "@/lib/quota";
import {
  composeBrandBrief,
  getOrCreatePreviewProject,
} from "@/lib/brand-preview";

/**
 * D10 · GET/POST /api/workspaces/[wsId]/brand-preview
 *
 * POST composes a brief from the workspace's CONFIRMED brand knowledge and runs
 * it through the EXISTING server-authoritative generate pipeline (§2): no AI
 * call here — just compose → reserve quota (PENDING Generation row) → enqueue a
 * `generate` job → return 202 + the generation id. The client polls the normal
 * `GET /generations/[id]?jobId=` endpoint. The worker loads the confirmed rule
 * library into AIConstraints (so the preview is brand-constrained) and writes
 * the GenerationVersion.
 *
 * GET returns the latest brand-preview generation (with versions) so the page
 * can display the most recent preview across refreshes.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "VIEWER");

    const project = await prisma.project.findFirst({
      where: { workspaceId: wsId, name: "品牌预览" },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (!project) return ok({ generation: null });

    const latest = await prisma.generation.findFirst({
      where: { workspaceId: wsId, projectId: project.id },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!latest) return ok({ generation: null });

    return ok({ generation: await getGeneration(latest.id) });
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    // Generating consumes provider budget → require EDITOR (same as /generations).
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const ws = await prisma.brandWorkspace.findUnique({
      where: { id: wsId },
      select: { name: true },
    });
    if (!ws) throw new ApiException(404, "Workspace not found");

    // Brand preview is an AI image output → latest-first (V0.02 #6); other
    // callers keep the deterministic default order (docs/10 #4).
    const rules = await getConfirmedRules(wsId, { order: "recency" });
    const brief = composeBrandBrief(ws.name, rules);
    if (!brief) {
      throw new ApiException(
        422,
        "请先在品牌套件中确认至少一条品牌规则（logo/字体/颜色/设计指南/图像/品牌指南），再生成品牌预览。",
      );
    }

    const project = await getOrCreatePreviewProject(wsId);

    // K1 — same atomic quota reservation as /generations. Owner/admin是无限额度。
    const reserved = await reserveGenerationQuota({
      workspaceId: wsId,
      count: 1,
      make: () => ({
        projectId: project.id,
        workspaceId: wsId,
        sceneType: "CAMPAIGN_KV",
        sellingPoint: brief,
        scene: "品牌形象展示",
        status: "PENDING",
      }),
    });
    const generationId = reserved[0]!.id;

    const jobData: GenerateJobData = {
      workspaceId: wsId,
      generationId,
      versionCount: 1,
      textMode: "layered",
    };
    const job = await generateQueue.add("generate", jobData, {
      removeOnComplete: 50,
      removeOnFail: 50,
      attempts: 1,
    });

    const shaped = await getGeneration(generationId);
    return ok({ generation: shaped, jobId: job.id }, { status: 202 });
  } catch (err) {
    return handleError(err);
  }
}

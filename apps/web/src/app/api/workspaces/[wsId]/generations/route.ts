import { prisma } from "@brandai/db";
import { CreateGenerationInput } from "@brandai/contracts";
import {
  ApiException,
  handleError,
  ok,
  parse,
  requireUser,
} from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { generateQueue } from "@/lib/queue";
import {
  getGeneration,
  listProjectGenerations,
} from "@/lib/generations";
import type { GenerateJobData } from "@/lib/workers/generate.worker";
import { getConfirmedRules } from "@/lib/rules";
import { serializeProhibition } from "@/lib/prohibitions";
import {
  compileAIConstraints,
  constraintsEnabled,
} from "@/lib/ai-constraints";
import { assertGenerationQuota } from "@/lib/quota";

/**
 * GET  /api/workspaces/[wsId]/generations?projectId=...
 *   → Generation[] (newest first, with versions), shaped to contracts.
 *
 * POST /api/workspaces/[wsId]/generations
 *   Body: CreateGenerationInput. Runs the pre-generation compliance
 *   precheck (blocks on a FORBIDDEN finding), creates a Generation row
 *   (status PENDING), enqueues a BullMQ `generate` job and returns
 *   `{ generation, jobId, precheck }`. The worker
 *   (lib/workers/generate.worker.ts) loads the CONFIRMED brand rule
 *   library, calls the AI service and writes the GenerationVersion rows.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireOwnedWorkspace(wsId, user.id);

    const projectId = new URL(req.url).searchParams.get("projectId");
    if (!projectId) throw new ApiException(400, "projectId is required");

    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project || project.workspaceId !== wsId) {
      throw new ApiException(404, "Project not found in this workspace");
    }

    return ok(await listProjectGenerations(projectId));
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const input = parse(CreateGenerationInput, await req.json());

    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
    });
    if (!project || project.workspaceId !== wsId) {
      throw new ApiException(404, "Project not found in this workspace");
    }

    // M-D — quota/rate-limit gate (402). Checked before any work so an
    // over-quota user neither runs the worker nor creates a row.
    await assertGenerationQuota(user.id);

    // §2.1 — NO AI calls in this handler. The earlier `await runPrecheck(...)`
    // (which makes an AI compliance call) lived here and caused POST to time
    // out → 529. AI precheck now runs in generate.worker.ts and surfaces a
    // blocking violation as Generation.status=FAILED with a readable error
    // (PrecheckBlockError → handled by the same FAILED path as HardBlockError).
    // The wizard has its own standalone advisory call to
    // /generations/precheck before submit, so users still see preventive
    // warnings client-side.

    // P1.2 — synchronous hard-block gate. If any HIGH-severity active
    // ProhibitionRule applies, refuse to enqueue and surface 422 with the
    // blocker list. The worker also re-checks (defense-in-depth) but the
    // synchronous path gives the UI a deterministic 422 + reason.
    if (constraintsEnabled()) {
      const [brandRules, prohRows] = await Promise.all([
        getConfirmedRules(wsId),
        prisma.prohibitionRule.findMany({
          where: { workspaceId: wsId, status: "ACTIVE", affectsGeneration: true },
        }),
      ]);
      const compiled = compileAIConstraints(
        brandRules,
        prohRows.map(serializeProhibition),
      );
      if (compiled.blockers.length > 0) {
        // Persist a FAILED Generation row so the workspace history reflects
        // the blocked attempt (matches the worker-side error semantics).
        const blockedGen = await prisma.generation.create({
          data: {
            projectId: input.projectId,
            workspaceId: wsId,
            sceneType: input.sceneType,
            sellingPoint: input.sellingPoint,
            scene: input.scene,
            status: "FAILED",
            error:
              "AI constraint hard-block: " +
              compiled.blockers
                .map((b) => `[${b.source}] ${b.reason}`)
                .join("; "),
          },
        });
        throw new ApiException(
          422,
          "存在禁用规则（HIGH 级禁用项或 FORBIDDEN 品牌规范），无法生成：" +
            compiled.blockers.map((b) => b.reason).join("；"),
          {
            blockers: compiled.blockers,
            generationId: blockedGen.id,
          },
        );
      }
    }

    const generation = await prisma.generation.create({
      data: {
        projectId: input.projectId,
        workspaceId: wsId,
        sceneType: input.sceneType,
        sellingPoint: input.sellingPoint,
        scene: input.scene,
        status: "PENDING",
      },
    });

    const jobData: GenerateJobData = {
      workspaceId: wsId,
      generationId: generation.id,
      versionCount: input.versionCount ?? 2,
      // M3 — text rendering strategy ("direct" default | "layered").
      textMode: input.textMode,
      // P2.0 — pass the target size list through to the worker. The
      // synchronous hard-block gate above runs once and covers the whole
      // batch; AI precheck happens inside the worker.
      ...(input.targets && input.targets.length > 0
        ? { targets: input.targets }
        : {}),
    };
    const job = await generateQueue.add("generate", jobData, {
      removeOnComplete: 50,
      removeOnFail: 50,
      // §2.4 — never auto-retry a wedged AI call. The watchdog inside the
      // worker marks the row FAILED on timeout; replaying would just burn
      // more provider cost. Explicit so a future global BullMQ default
      // change can't silently re-run AI calls.
      attempts: 1,
    });

    const shaped = await getGeneration(generation.id);
    return ok({ generation: shaped, jobId: job.id }, { status: 202 });
  } catch (err) {
    return handleError(err);
  }
}

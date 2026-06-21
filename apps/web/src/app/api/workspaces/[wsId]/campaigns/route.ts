import { prisma } from "@brandai/db";
import { CampaignKitInput } from "@brandai/contracts";
import {
  ApiException,
  handleError,
  ok,
  parse,
  requireUser,
} from "@/lib/api";
import { requireWorkspaceRole } from "@/lib/workspace";
import { generateQueue } from "@/lib/queue";
import { getGeneration } from "@/lib/generations";
import type { GenerateJobData } from "@/lib/workers/generate.worker";
import { getConfirmedRules } from "@/lib/rules";
import { serializeProhibition } from "@/lib/prohibitions";
import { compileAIConstraints, constraintsEnabled } from "@/lib/ai-constraints";
import { reserveGenerationQuota } from "@/lib/quota";
import { dedupedSceneCount } from "@brandai/contracts";

/**
 * E8 Campaign Kit · POST /api/workspaces/[wsId]/campaigns
 *
 * One brief → a whole set of channel materials. Creates one Generation per
 * DISTINCT `scenes[]` entry (each fanning out to one image per `targets[]` size
 * via the existing multi-size generate worker), all under the same Project.
 *
 * The synchronous gates run ONCE for the whole kit (not per scene):
 *  - quota: atomic reservation for the DEDUPED scene count (no half kit, no
 *    false 402 from a repeated scene), metered against the workspace owner;
 *  - hard-block: HIGH prohibitions / FORBIDDEN rules abort the whole kit.
 * The compliance precheck (slow AI) runs per-scene IN THE WORKER (K3 / §2), so
 * the POST returns 202 immediately. Then one `generate` job is enqueued per
 * reserved Generation.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ wsId: string }> },
) {
  try {
    const user = await requireUser();
    const { wsId } = await params;
    await requireWorkspaceRole(wsId, user.id, "EDITOR");

    const input = parse(CampaignKitInput, await req.json());

    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
    });
    if (!project || project.workspaceId !== wsId) {
      throw new ApiException(404, "Project not found in this workspace");
    }

    // K3 / §2 — the compliance precheck (a slow AI call) used to be `await`-ed
    // HERE in the HTTP handler, violating the "no slow AI in a request handler"
    // rule. It now runs inside the generate worker (per-scene, server-
    // authoritative) exactly like the single-generation path, so the kit POST
    // returns 202 promptly. The hard-block + quota gates remain synchronous
    // (fast DB-only checks).

    // Hard-block gate — runs once for the whole kit.
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
        throw new ApiException(
          422,
          "存在禁用规则（HIGH 级禁用项或 FORBIDDEN 品牌规范），无法生成：" +
            compiled.blockers.map((b) => b.reason).join("；"),
          { blockers: compiled.blockers },
        );
      }
    }

    // Fan out: one Generation per DISTINCT scene type (deduped, order
    // preserved). K1 — quota is metered on the DEDUPED scene count via the
    // atomic reservation, NOT the raw `scenes.length`: a repeated scene must
    // not inflate the count and trigger a false 402 (this exact bug is in the
    // phase-2 backlog). The whole kit is reserved at once (serializable txn) so
    // a user never gets a half-finished set then a 402 mid-way, and concurrent
    // kits can't over-spend. Metered against the workspace OWNER (tenant).
    const sceneTypes = [...new Set(input.scenes)];
    const reserved = await reserveGenerationQuota({
      workspaceId: wsId,
      count: dedupedSceneCount(input.scenes),
      make: (i) => ({
        projectId: input.projectId,
        workspaceId: wsId,
        sceneType: sceneTypes[i]!,
        sellingPoint: input.sellingPoint,
        scene: input.scene,
        status: "PENDING",
      }),
    });

    const scenes: Array<{
      sceneType: string;
      generation: Awaited<ReturnType<typeof getGeneration>>;
      jobId: string | undefined;
    }> = [];
    for (let i = 0; i < sceneTypes.length; i += 1) {
      const sceneType = sceneTypes[i]!;
      const generationId = reserved[i]!.id;
      const jobData: GenerateJobData = {
        workspaceId: wsId,
        generationId,
        versionCount: 1,
        textMode: input.textMode,
        targets: input.targets,
      };
      const job = await generateQueue.add("generate", jobData, {
        removeOnComplete: 50,
        removeOnFail: 50,
      });
      scenes.push({
        sceneType,
        generation: await getGeneration(generationId),
        jobId: job.id,
      });
    }

    return ok({ projectId: input.projectId, scenes }, { status: 202 });
  } catch (err) {
    return handleError(err);
  }
}

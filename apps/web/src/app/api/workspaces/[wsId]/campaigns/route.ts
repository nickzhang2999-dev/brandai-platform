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
import { runPrecheck } from "@/lib/precheck";
import { getGeneration } from "@/lib/generations";
import type { GenerateJobData } from "@/lib/workers/generate.worker";
import { getConfirmedRules } from "@/lib/rules";
import { serializeProhibition } from "@/lib/prohibitions";
import { compileAIConstraints, constraintsEnabled } from "@/lib/ai-constraints";
import { assertGenerationQuota } from "@/lib/quota";

/**
 * E8 Campaign Kit · POST /api/workspaces/[wsId]/campaigns
 *
 * One brief → a whole set of channel materials. Creates one Generation per
 * `scenes[]` entry (each fanning out to one image per `targets[]` size via the
 * existing multi-size generate worker), all under the same Project.
 *
 * The expensive gates run ONCE for the whole kit (not per scene):
 *  - quota: aggregate check for `scenes.length` generations (no half kit);
 *  - precheck: the shared selling point (FORBIDDEN blocks the whole kit);
 *  - hard-block: HIGH prohibitions / FORBIDDEN rules abort the whole kit.
 * Then one Generation row + `generate` job is enqueued per scene.
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

    // Aggregate quota gate — the WHOLE kit (one generation per scene) must fit,
    // so a user never gets a half-finished set then a 402 mid-way.
    await assertGenerationQuota(user.id, input.scenes.length);

    // Pre-generation compliance precheck on the shared selling point.
    const precheck = await runPrecheck({
      workspaceId: wsId,
      text: input.sellingPoint,
      baseUrl: new URL(req.url).origin,
    });
    if (precheck.blocking) {
      throw new ApiException(
        422,
        "卖点文案存在违禁风险，请修改后再生成",
        precheck,
      );
    }

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

    // Fan out: one Generation + job per scene type (deduped, order preserved).
    const sceneTypes = [...new Set(input.scenes)];
    const scenes: Array<{
      sceneType: string;
      generation: Awaited<ReturnType<typeof getGeneration>>;
      jobId: string | undefined;
    }> = [];
    for (const sceneType of sceneTypes) {
      const generation = await prisma.generation.create({
        data: {
          projectId: input.projectId,
          workspaceId: wsId,
          sceneType,
          sellingPoint: input.sellingPoint,
          scene: input.scene,
          status: "PENDING",
        },
      });
      const jobData: GenerateJobData = {
        workspaceId: wsId,
        generationId: generation.id,
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
        generation: await getGeneration(generation.id),
        jobId: job.id,
      });
    }

    return ok(
      { projectId: input.projectId, scenes, precheck },
      { status: 202 },
    );
  } catch (err) {
    return handleError(err);
  }
}

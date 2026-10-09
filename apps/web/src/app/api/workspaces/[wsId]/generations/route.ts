import { prepareGeneration } from "@/lib/generation-prepare";
import { prisma } from "@brandai/db";
import { CreateGenerationInput } from "@brandai/contracts";
import { ApiException, handleError, ok, parse, requireUser } from "@/lib/api";
import { requireOwnedWorkspace, requireWorkspaceRole } from "@/lib/workspace";
import { generateQueue } from "@/lib/queue";
import { getGeneration, listProjectGenerations } from "@/lib/generations";
import type { GenerateJobData } from "@/lib/workers/generate.worker";
import { reserveGenerationQuota } from "@/lib/quota";

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
    const prepared = await prepareGeneration(wsId, input);
    const reserved = await reserveGenerationQuota({ workspaceId: wsId, count: 1, make: () => prepared.generationData });
    const generation = { id: reserved[0]!.id };
    const jobData: GenerateJobData = { ...prepared.jobData, generationId: generation.id };
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

import { prisma } from "@brandai/db";
import {
  CreateGenerationInput,
  WatermarkOverlayInput,
} from "@brandai/contracts";
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
import {
  assertExampleAssetsInWorkspace,
  serializeProhibition,
} from "@/lib/prohibitions";
import {
  compileAIConstraints,
  constraintsEnabled,
} from "@/lib/ai-constraints";
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
    const legacyReferenceAssets = Array.from(
      new Map(
        [
          ...(input.referenceAssetIds ?? []).map((assetId) => ({
            assetId,
            mode: "INSPIRATION" as const,
          })),
          ...(input.referenceAssets ?? []).map((item) => ({
            assetId: item.assetId,
            mode: item.mode ?? ("INSPIRATION" as const),
          })),
        ].map((item) => [item.assetId, item]),
      ).values(),
    );
    const legacyStrictIds = legacyReferenceAssets
      .filter((item) => item.mode === "STRICT")
      .map((item) => item.assetId);
    const legacyInspirationIds = legacyReferenceAssets
      .filter((item) => item.mode !== "STRICT")
      .map((item) => item.assetId);
    const templateReferenceAssetIds = Array.from(
      new Set([...(input.templateReferenceAssetIds ?? []), ...legacyInspirationIds]),
    );
    const watermarkOverlays = [
      ...(input.watermarkOverlays ?? []).map((overlay) =>
        WatermarkOverlayInput.parse(overlay),
      ),
      ...legacyStrictIds.map((assetId) => ({
        assetId,
        enabled: true,
        anchor: "bottom-right" as const,
        positionMode: "pixel" as const,
        offsetX: 24,
        offsetY: 24,
        widthPx: 120,
        fontFamily: "Inter",
        fontSizePx: 28,
        opacity: 0.85,
        textColor: "#111827",
        backgroundEnabled: false,
        backgroundColor: "#FFFFFF",
        borderEnabled: false,
        borderColor: "#7C5CFF",
        borderWidth: 1,
        cornerRadius: 0,
      })),
    ].map((overlay) => WatermarkOverlayInput.parse(overlay));

    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
    });
    if (!project || project.workspaceId !== wsId) {
      throw new ApiException(404, "Project not found in this workspace");
    }

    if (templateReferenceAssetIds.length > 0) {
      const refIds = templateReferenceAssetIds;
      await assertExampleAssetsInWorkspace(wsId, refIds);
      // Reference assets must be generatable IMAGES (mirror the worker's
      // lifecycle/type filter) so an unusable pick fails fast with a clear 400
      // instead of being accepted here and silently dropped from the AI job.
      const usable = await prisma.asset.findMany({
        where: {
          id: { in: refIds },
          workspaceId: wsId,
          availableForGeneration: true,
          deprecatedAt: null,
          mimeType: { startsWith: "image/" },
          libraryKind: { in: ["TEMPLATE", "MATERIAL"] },
        },
        select: { id: true },
      });
      if (usable.length !== refIds.length) {
        const ok = new Set(usable.map((a: { id: string }) => a.id));
        const bad = refIds.filter((id: string) => !ok.has(id));
        throw new ApiException(
          400,
          `参考素材不可用于生成（需为未停用、未弃用的图片素材）：${bad.join(", ")}`,
        );
      }
    }
    const watermarkAssetIds = Array.from(
      new Set(
        watermarkOverlays
          .map((overlay) => overlay.assetId)
          .filter((id): id is string => !!id),
      ),
    );
    if (watermarkAssetIds.length > 0) {
      await assertExampleAssetsInWorkspace(wsId, watermarkAssetIds);
      const usable = await prisma.asset.findMany({
        where: {
          id: { in: watermarkAssetIds },
          workspaceId: wsId,
          availableForGeneration: true,
          deprecatedAt: null,
          mimeType: { startsWith: "image/" },
          libraryKind: "MATERIAL",
        },
        select: { id: true },
      });
      if (usable.length !== watermarkAssetIds.length) {
        const ok = new Set(usable.map((a: { id: string }) => a.id));
        const bad = watermarkAssetIds.filter((id: string) => !ok.has(id));
        throw new ApiException(
          400,
          `水印素材不可用于生成（需为素材库内未停用、未弃用的图片）：${bad.join(", ")}`,
        );
      }
    }

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

    // K1 — atomic quota reservation (metered by workspace OWNER, not the
    // invoking collaborator). The PENDING Generation row IS the reservation;
    // the serializable transaction prevents concurrent over-spend. Default /
    // owner / admin plan is unlimited → fast no-transaction path, phase-1
    // behavior unchanged. Over-quota throws 402 here before any work/enqueue.
    const reserved = await reserveGenerationQuota({
      workspaceId: wsId,
      count: 1,
      make: () => ({
        projectId: input.projectId,
        workspaceId: wsId,
        sceneType: input.sceneType,
        sellingPoint: input.sellingPoint,
        scene: input.scene,
        status: "PENDING",
      }),
    });
    const generation = { id: reserved[0]!.id };

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
      // F7 / F9 / L8 — thread per-generation style keywords + reference asset
      // ids to the worker (merged into AIConstraints there).
      ...(input.styleKeywords && input.styleKeywords.length > 0
        ? { styleKeywords: input.styleKeywords }
        : {}),
      ...(templateReferenceAssetIds.length > 0
        ? { templateReferenceAssetIds }
        : {}),
      ...(watermarkOverlays.length > 0 ? { watermarkOverlays } : {}),
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

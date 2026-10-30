import type { Prisma } from "@brandai/db";
import { StudioLayerRepairContext } from "@brandai/contracts";
import { ApiException } from "./api";
import type { StudioEditSourceSnapshot } from "./studio-generation-edit";

type Db = Pick<Prisma.TransactionClient, "studioDecompositionRequest" | "$queryRaw">;
type Source = Pick<StudioEditSourceSnapshot, "assetId" | "sha256" | "shapeId" | "width" | "height">;
const unavailable = () => new ApiException(409, "原分层任务或原图已变更，未继续背景修复。请重新选择原图与分层记录。");

/** Caller authorizes the current editor/project. A collaborator may continue a
 * completed project task, but cannot substitute another project's receipt or
 * a generated layer for the verified original. The parent remains unchanged. */
export async function requireStudioLayerRepairParent(db: Db, workspaceId: string, projectId: string,
  requestId: string, source: Source, lock = false): Promise<StudioLayerRepairContext> {
  if (lock) await db.$queryRaw`SELECT "id" FROM "StudioDecompositionRequest" WHERE "id" = ${requestId} AND "workspaceId" = ${workspaceId} AND "projectId" = ${projectId} FOR SHARE`;
  const parent = await db.studioDecompositionRequest.findFirst({ where: { id: requestId, workspaceId, projectId, status: "SUCCEEDED" },
    select: { id: true, workspaceId: true, projectId: true, status: true, sourceShapeId: true, assetId: true, assetSha256: true, sourceWidth: true, sourceHeight: true } });
  if (!parent || parent.id !== requestId || parent.workspaceId !== workspaceId || parent.projectId !== projectId || parent.status !== "SUCCEEDED"
    || parent.sourceShapeId !== source.shapeId || parent.assetId !== source.assetId || parent.assetSha256 !== source.sha256
    || parent.sourceWidth !== source.width || parent.sourceHeight !== source.height) throw unavailable();
  return StudioLayerRepairContext.parse({ decompositionRequestId: parent.id, sourceShapeId: parent.sourceShapeId,
    assetId: parent.assetId, assetSha256: parent.assetSha256, width: parent.sourceWidth, height: parent.sourceHeight,
    mode: "inferred-completion", independentQuality: "NOT_REVIEWED" });
}

/** Used by claim, the immediate pre-provider fence, and final archive. */
export async function inspectStudioLayerRepair(db: Db, workspaceId: string, projectId: string, raw: unknown,
  source: Source | undefined | null, operation: unknown, lock = false): Promise<StudioLayerRepairContext> {
  const parsed = StudioLayerRepairContext.safeParse(raw);
  if (!parsed.success || !source || operation !== "inpaint") throw unavailable();
  const context = parsed.data;
  if (context.sourceShapeId !== source.shapeId || context.assetId !== source.assetId || context.assetSha256 !== source.sha256
    || context.width !== source.width || context.height !== source.height) throw unavailable();
  return requireStudioLayerRepairParent(db, workspaceId, projectId, context.decompositionRequestId, source, lock);
}

/** Internal AI-service evidence only. Do not copy arbitrary provider params or
 * treat pixel preservation as visual/semantic approval. Old AI responses have
 * no evidence; keep them compatible without inventing a successful check. */
export function studioImageToolPixelEvidence(operation: unknown, raw: Record<string, unknown>, width: number, height: number) {
  if (operation !== "inpaint" || raw.sourcePixelProtection !== "outside-mask" || raw.independentQuality !== "not-reviewed"
    || !Number.isSafeInteger(raw.protectedPixelCount) || !Number.isSafeInteger(raw.editedPixelCount)
    || Number(raw.protectedPixelCount) < 0 || Number(raw.editedPixelCount) <= 0
    || Number(raw.protectedPixelCount) + Number(raw.editedPixelCount) !== width * height
    || typeof raw.maskSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.maskSha256)) return {};
  return { imageToolPixelEvidence: { sourcePixelProtection: "outside-mask", protectedPixelCount: Number(raw.protectedPixelCount),
    editedPixelCount: Number(raw.editedPixelCount), maskSha256: raw.maskSha256, independentQuality: "not-reviewed" } };
}

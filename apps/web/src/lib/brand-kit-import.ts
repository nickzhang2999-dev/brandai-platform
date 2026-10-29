import { createHash } from "node:crypto";
import { prisma } from "@brandai/db";
import { ApiException } from "./api";
import type { RuleType } from "@brandai/contracts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function brandKitTaskId(workspaceId: string, userId: string, kind: string, mutationId: string) {
  return "bkit_" + hash([workspaceId, userId, kind, mutationId]);
}
export async function brandKitImportTask(workspaceId: string, userId: string, kind: "RECOGNIZE" | "PARSE_MANUAL", mutationId: string, payload: unknown) {
  const id = brandKitTaskId(workspaceId, userId, kind, mutationId), payloadHash = hash(payload);
  const row = await prisma.asyncTask.upsert({ where: { id }, create: { id, workspaceId, kind,
    inputJson: { userId, mutationId, payloadHash } }, update: {} });
  const saved = row.inputJson as { userId?: string; payloadHash?: string } | null;
  if (row.workspaceId !== workspaceId || row.kind !== kind || saved?.userId !== userId || saved.payloadHash !== payloadHash) throw new ApiException(409, "这次解析标识已用于其它内容，请重新选择素材。");
  return row;
}
export async function readBrandKitImportTask(workspaceId: string, userId: string, kind: string, mutationId: string) {
  const row = await prisma.asyncTask.findFirst({ where: { id: brandKitTaskId(workspaceId, userId, kind, mutationId), workspaceId, kind,
    inputJson: { path: ["userId"], equals: userId } } });
  if (!row) throw new ApiException(404, "没有找到这次解析任务。");
  return { taskId: row.id, jobId: row.jobId, status: row.status };
}
/** Preserve model advice as evidence, but never overwrite the user's category
 * or expose another category's structured data as if it were a logo schema. */
export function classifyBrandKitRule<T extends { type: RuleType; value: Record<string, unknown>; evidence: { note?: string; [key: string]: unknown }[] }>(rule: T, targetType?: RuleType) {
  if (!targetType || targetType === rule.type) return rule;
  return { ...rule, type: targetType, value: { analysisSuggestion: { type: rule.type, value: rule.value } },
    evidence: [...rule.evidence, { note: `用户选择归入 ${targetType}；模型建议分类为 ${rule.type}，内容仍待人工核对。` }] } as T;
}
export function brandKitAssetIdentity(workspaceId: string, userId: string, bytes: Buffer, category: string, folderId: string | null) {
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const id = "bkit_asset_" + hash([workspaceId, userId, contentHash, category, folderId]);
  return { id, objectKey: `${workspaceId}/brand-kit/${id}/${contentHash}` };
}
export function assertBrandKitAssetReusable(row: { workspaceId: string; category: string; libraryKind: string; folderId: string | null; deprecatedAt: Date | null; availableForGeneration: boolean }, workspaceId: string, category: string, folderId: string | null) {
  if (row.workspaceId !== workspaceId || row.category !== category || row.libraryKind !== "BRAND_KIT" || row.folderId !== folderId || row.deprecatedAt || !row.availableForGeneration) throw new ApiException(409, "相同素材已被移除或调整分类，请先在素材库核对；不会自动覆盖原素材。");
}

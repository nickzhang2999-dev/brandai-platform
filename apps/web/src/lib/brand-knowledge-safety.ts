import { prisma, Prisma } from "@brandai/db";
import { VI } from "@brandai/contracts";
import { ApiException } from "./api";

export async function lockBrandKnowledgeWorkspace(tx: Prisma.TransactionClient, workspaceId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "BrandWorkspace" WHERE "id" = ${workspaceId} FOR UPDATE`;
  if (!rows.length) throw new ApiException(404, "Workspace not found");
}

export function validatedRuleStructured(type: string, structured: unknown): Prisma.InputJsonValue | undefined {
  if (structured === undefined) return undefined;
  const moduleName = VI.RULE_TYPE_TO_MODULE[type];
  const schema = moduleName ? VI.MODULE_BY_NAME[moduleName] : undefined;
  if (!schema || !structured || typeof structured !== "object" || Array.isArray(structured)) {
    throw new ApiException(400, "Invalid structured rule payload");
  }
  const parsed = schema.safeParse({ ...structured, module: moduleName });
  if (!parsed.success) throw new ApiException(400, "Invalid structured rule payload");
  return parsed.data as unknown as Prisma.InputJsonValue;
}

/** Only schema-defined asset references count; free notes are never parsed as IDs. */
export async function assertRuleAssetsInWorkspace(
  tx: Prisma.TransactionClient | typeof prisma, workspaceId: string,
  rule: { evidence?: unknown; structured?: unknown },
) {
  const ids = new Set<string>();
  if (Array.isArray(rule.evidence)) for (const item of rule.evidence) {
    if (item && typeof item === "object" && typeof item.assetId === "string") ids.add(item.assetId);
  }
  const structured = rule.structured as { primary_logo_asset_id?: unknown } | undefined | null;
  if (structured && typeof structured.primary_logo_asset_id === "string") ids.add(structured.primary_logo_asset_id);
  if (!ids.size) return;
  const rows = await tx.asset.findMany({ where: { workspaceId, id: { in: [...ids] } }, select: { id: true } });
  if (rows.length !== ids.size) throw new ApiException(400, "规则引用的素材不属于当前品牌或已删除。");
}

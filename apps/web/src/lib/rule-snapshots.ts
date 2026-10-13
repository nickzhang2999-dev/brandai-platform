import { prisma, Prisma } from "@brandai/db";
import type {
  BrandRule,
  RuleSnapshotSummary,
  RestoreRuleSnapshotResult,
} from "@brandai/contracts";
import { getConfirmedRules } from "@/lib/rules";
import { z } from "zod";
import { BrandRule as BrandRuleSchema } from "@brandai/contracts";
import { assertRuleAssetsInWorkspace, lockBrandKnowledgeWorkspace } from "./brand-knowledge-safety";

/**
 * C8 规则版本管理 — the single source of truth for capturing / listing /
 * restoring CONFIRMED brand-rule snapshots. A snapshot stores the serialized
 * CONFIRMED rule set (lib/rules.ts#serializeRule shape) so a restore can
 * rebuild the library exactly, independent of later edits or deletes.
 */

type SerializedRule = BrandRule & {
  structured?: Record<string, unknown> | null;
};

/** Map a Prisma RuleSnapshot row to the wire summary (drops the rules blob). */
function toSummary(row: {
  id: string;
  workspaceId: string;
  label: string;
  note: string | null;
  createdById: string | null;
  ruleCount: number;
  createdAt: Date;
}): RuleSnapshotSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    label: row.label,
    ...(row.note ? { note: row.note } : {}),
    ...(row.createdById ? { createdById: row.createdById } : {}),
    ruleCount: row.ruleCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Capture the workspace's current CONFIRMED rule set as a named snapshot. */
export async function createRuleSnapshot(
  workspaceId: string,
  input: { label: string; note?: string },
  createdById?: string,
): Promise<RuleSnapshotSummary> {
  return prisma.$transaction(async tx => {
    await lockBrandKnowledgeWorkspace(tx, workspaceId);
    return captureSnapshot(tx, workspaceId, input, createdById);
  });
}

async function captureSnapshot(tx: Prisma.TransactionClient, workspaceId: string,
  input: { label: string; note?: string }, createdById?: string) {
  const rules = await getConfirmedRules(workspaceId, { client: tx });
  const row = await tx.ruleSnapshot.create({
    data: {
      workspaceId,
      label: input.label,
      note: input.note ?? null,
      createdById: createdById ?? null,
      ruleCount: rules.length,
      rules: rules as unknown as Prisma.InputJsonValue,
    },
  });
  return toSummary(row);
}

export async function listRuleSnapshots(
  workspaceId: string,
): Promise<RuleSnapshotSummary[]> {
  const rows = await prisma.ruleSnapshot.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toSummary);
}

/** Build Prisma create/update data from a serialized snapshot rule. */
function ruleData(r: SerializedRule) {
  return {
    type: r.type,
    strength: r.strength,
    status: "CONFIRMED" as const,
    summary: r.summary,
    value: (r.value ?? {}) as Prisma.InputJsonValue,
    structured:
      r.structured == null
        ? Prisma.DbNull
        : (r.structured as Prisma.InputJsonValue),
    evidence: (Array.isArray(r.evidence)
      ? r.evidence
      : []) as Prisma.InputJsonValue,
  };
}

/**
 * Roll the workspace's CONFIRMED rule library back to a snapshot. The library
 * is made to match the snapshot exactly:
 *  - rules in the snapshot are re-created (if deleted) or overwritten back to
 *    their snapshot state and set CONFIRMED;
 *  - rules currently CONFIRMED but absent from the snapshot are retired
 *    (status → REJECTED), not deleted (so no data loss).
 *
 * Reversible: before applying, the current CONFIRMED set is auto-captured as a
 * backup snapshot, so a restore can itself be rolled back.
 */
export async function restoreRuleSnapshot(
  workspaceId: string,
  snapshotId: string,
  actorId?: string,
): Promise<RestoreRuleSnapshotResult> {
  return prisma.$transaction(async (tx) => {
    await lockBrandKnowledgeWorkspace(tx, workspaceId);
    const snapshot = await tx.ruleSnapshot.findUnique({ where: { id: snapshotId } });
    if (!snapshot || snapshot.workspaceId !== workspaceId) throw new Error("SNAPSHOT_NOT_FOUND");
    const parsed = z.array(BrandRuleSchema.extend({ structured: z.record(z.unknown()).nullable().optional() })).safeParse(snapshot.rules);
    if (!parsed.success || parsed.data.some(r => r.workspaceId !== workspaceId || r.status !== "CONFIRMED")
      || new Set(parsed.data.map(r => r.id)).size !== parsed.data.length || snapshot.ruleCount !== parsed.data.length) {
      throw new Error("SNAPSHOT_INVALID");
    }
    const snapRules = parsed.data as SerializedRule[];
    const snapIds = new Set(snapRules.map(r => r.id));
    const existing = await tx.brandRule.findMany({ where: { id: { in: [...snapIds] } }, select: { id: true, workspaceId: true } });
    if (existing.some(r => r.workspaceId !== workspaceId)) throw new Error("SNAPSHOT_INVALID");
    for (const rule of snapRules) await assertRuleAssetsInWorkspace(tx, workspaceId, rule);
    // Backup and restore share one transaction/lock. No partial backup or lost intervening edit.
    const backup = await captureSnapshot(tx, workspaceId,
      { label: `回滚前自动备份 · ${new Date().toISOString().slice(0, 16)}` }, actorId);
    // Retire confirmed rules that the snapshot does not contain.
    const currentConfirmed = await tx.brandRule.findMany({
      where: { workspaceId, status: "CONFIRMED" },
      select: { id: true },
    });
    const toRetire = currentConfirmed.filter((r) => !snapIds.has(r.id));
    if (toRetire.length > 0) {
      await tx.brandRule.updateMany({
        where: { workspaceId, id: { in: toRetire.map((r) => r.id) } },
        data: { status: "REJECTED" },
      });
    }

    // Re-assert each snapshot rule (recreate if deleted, else overwrite).
    for (const r of snapRules) {
      const data = ruleData(r);
      await tx.brandRule.upsert({
        where: { id: r.id },
        update: data,
        create: { id: r.id, workspaceId, ...data },
      });
    }

    return { restored: snapRules.length, retired: toRetire.length, backupSnapshotId: backup.id };
  });
}

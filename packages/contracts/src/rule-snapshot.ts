import { z } from "zod";

/**
 * C8 规则版本管理 — web-BFF-only contract (no AI service counterpart, so no
 * Pydantic mirror). A RuleSnapshot is an immutable capture of a workspace's
 * CONFIRMED brand-rule set; restoring one rebuilds the library to that point.
 */

/** List-row metadata. The full `rules` payload is intentionally omitted from
 *  the list response (it can be large); restore reads it server-side. `note`
 *  / `createdById` are `.optional()` (omitted, not null) per the contract
 *  null-vs-optional boundary. */
export const RuleSnapshotSummary = z.object({
  id: z.string(),
  workspaceId: z.string(),
  label: z.string(),
  note: z.string().optional(),
  createdById: z.string().optional(),
  ruleCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type RuleSnapshotSummary = z.infer<typeof RuleSnapshotSummary>;

export const ListRuleSnapshotsResponse = z.object({
  snapshots: z.array(RuleSnapshotSummary),
});
export type ListRuleSnapshotsResponse = z.infer<
  typeof ListRuleSnapshotsResponse
>;

/** POST body — save the current CONFIRMED rule set as a named version. */
export const CreateRuleSnapshotInput = z.object({
  label: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).optional(),
});
export type CreateRuleSnapshotInput = z.infer<typeof CreateRuleSnapshotInput>;

/** Restore result — how the library changed when rolling back to a snapshot. */
export const RestoreRuleSnapshotResult = z.object({
  restored: z.number().int().nonnegative(),
  /** confirmed rules that were not in the snapshot and got retired (REJECTED) */
  retired: z.number().int().nonnegative(),
  /** id of the auto-captured backup of the pre-restore state */
  backupSnapshotId: z.string(),
});
export type RestoreRuleSnapshotResult = z.infer<
  typeof RestoreRuleSnapshotResult
>;

import { z } from "zod";

/** Reserved adapter boundary; this is NOT an HTTP endpoint or a publish grant.
 * The Omni service creates it from authenticated, persisted records. Never trust
 * review/rights fields supplied by a model or by a browser. */
const id = z.string().min(1).max(128).refine(value => value.trim().length > 0);
const version = z.string().min(1).max(200).refine(value => value.trim().length > 0);
export const OmniAssetIdentity = z.object({ asset_id: id,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const permission = z.enum(["allowed", "denied", "unknown"]);
export const OmniAssetWorkflow = z.object({
  schema_version: z.literal(1),
  source: OmniAssetIdentity,
  analysis: z.object({ status: z.enum(["not_requested", "queued", "running", "completed", "failed"]),
    job_id: id.nullable(), model_version: version.nullable(),
  }).strict(),
  ai_review: z.object({ status: z.enum(["not_requested", "queued", "running", "completed", "failed"]),
    suggestion: z.enum(["accept", "reject", "needs_human"]).nullable(),
    policy_version: version.nullable(), job_id: id.nullable(),
  }).strict(),
  human_review: z.discriminatedUnion("status", [
    z.object({ status: z.enum(["unknown", "pending"]), reviewer_id: z.null(), decided_at: z.null() }).strict(),
    z.object({ status: z.enum(["approved", "rejected"]), reviewer_id: id, decided_at: z.string().datetime({ offset: true }) }).strict(),
  ]),
  permissions: z.object({ analysis: permission, display: permission, export: permission }).strict(),
  publication: z.enum(["draft", "published", "withdrawn"]),
}).strict().superRefine((value, context) => {
  if ((value.analysis.status !== "not_requested" && !value.analysis.job_id)
    || (value.analysis.status === "not_requested" && (value.analysis.job_id !== null || value.analysis.model_version !== null))
    || (value.analysis.status === "completed" && !value.analysis.model_version))
    context.addIssue({ code: "custom", message: "Analysis requires its persisted job and completed model identity" });
  if ((value.ai_review.status === "not_requested" ? value.ai_review.job_id !== null || value.ai_review.policy_version !== null
    : !value.ai_review.job_id || !value.ai_review.policy_version)
    || (value.ai_review.status === "completed") !== (value.ai_review.suggestion !== null))
    context.addIssue({ code: "custom", message: "AI review suggestions require a completed policy-versioned job" });
});
export type OmniAssetWorkflow = z.infer<typeof OmniAssetWorkflow>;
export type OmniAssetIdentity = z.infer<typeof OmniAssetIdentity>;

/** A pure eligibility check. It does not authenticate, publish, schedule, retry,
 * or alter permissions. The existing signed publication path remains required. */
export function evaluateOmniAssetWorkflow(raw: unknown, current: OmniAssetIdentity) {
  const state = OmniAssetWorkflow.parse(raw), identity = OmniAssetIdentity.parse(current);
  const blockers: ("stale_source" | "human_review_required" | "display_not_allowed" | "export_not_allowed" | "withdrawn")[] = [];
  if (state.source.asset_id !== identity.asset_id || state.source.revision !== identity.revision || state.source.sha256 !== identity.sha256) blockers.push("stale_source");
  if (state.human_review.status !== "approved") blockers.push("human_review_required");
  if (state.permissions.display !== "allowed") blockers.push("display_not_allowed");
  if (state.permissions.export !== "allowed") blockers.push("export_not_allowed");
  if (state.publication === "withdrawn") blockers.push("withdrawn");
  return { state, eligibleForPublication: blockers.length === 0, blockers };
}

import { describe, expect, it } from "vitest";
import { OmniAssetWorkflow, evaluateOmniAssetWorkflow } from "../src/omni-asset-workflow";

const source = { asset_id: "fixture-asset", revision: 2, sha256: "a".repeat(64) };
const state = { schema_version: 1, source,
  analysis: { status: "completed", job_id: "analysis-1", model_version: "fixture-model" },
  ai_review: { status: "completed", suggestion: "accept", policy_version: "review-r1", job_id: "review-1" },
  human_review: { status: "unknown", reviewer_id: null, decided_at: null },
  permissions: { analysis: "allowed", display: "unknown", export: "unknown" }, publication: "draft" };
const approved = { ...state, human_review: { status: "approved", reviewer_id: "fixture-reviewer", decided_at: "2026-10-30T12:00:00+08:00" }, permissions: { analysis: "allowed", display: "allowed", export: "allowed" } };

describe("reserved Omni review adapter", () => {
  it("AI success and accept never imply human review or publication permission", () => {
    expect(evaluateOmniAssetWorkflow(state, source)).toMatchObject({ eligibleForPublication: false,
      blockers: ["human_review_required", "display_not_allowed", "export_not_allowed"] });
  });
  it.each([{ revision: 3 }, { sha256: "b".repeat(64) }, { asset_id: "another" }])("rejects stale or cross-asset decisions %j", patch => {
    expect(evaluateOmniAssetWorkflow(approved, { ...source, ...patch }).blockers).toEqual(["stale_source"]);
  });
  it("separates eligibility from publishing and preserves withdrawn state", () => {
    expect(evaluateOmniAssetWorkflow(approved, source)).toMatchObject({ eligibleForPublication: true, state: { publication: "draft" } });
    expect(evaluateOmniAssetWorkflow({ ...approved, publication: "withdrawn" }, source).blockers).toEqual(["withdrawn"]);
    expect(approved.publication).toBe("draft");
  });
  it("allows independent human review even if an analysis failed", () => {
    expect(evaluateOmniAssetWorkflow({ ...approved, analysis: { status: "failed", job_id: "analysis-1", model_version: null } }, source).eligibleForPublication).toBe(true);
  });
  it.each([
    { human_review: { status: "approved", reviewer_id: null, decided_at: null } },
    { ai_review: { ...state.ai_review, status: "running" } },
    { ai_review: { ...state.ai_review, policy_version: null } },
    { analysis: { ...state.analysis, model_version: null } },
    { source: { ...source, revision: true } }, { schema_version: true }, { token: "forbidden-field" },
  ])("rejects missing execution evidence, forged review shapes and extra fields %j", patch => {
    expect(OmniAssetWorkflow.safeParse({ ...state, ...patch }).success).toBe(false);
  });
});

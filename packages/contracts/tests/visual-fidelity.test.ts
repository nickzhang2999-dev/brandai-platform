import { describe, expect, it } from "vitest";
import { ComplianceCheckRequest, ComplianceCheckResponse, GenerateRequest, VisualFidelityPlan, VisualFidelityReport, VisualFidelitySourceImage } from "../src";
const sha = "a".repeat(64);
const constraint = { id: "apple", target: "left apple", attribute: "colour", expected: "green", strength: "hard", source: "user" };
const plan = { revision: "visual-fidelity-guard/1", inputSha256: sha, constraints: [constraint] };
describe("visual fidelity wire contract", () => {
  it("accepts bound requests and preserves legacy requests", () => {
    const legacy = ComplianceCheckRequest.parse({ termLib: [] });
    expect(legacy).not.toHaveProperty("visualFidelityPlan");
    expect(ComplianceCheckRequest.parse({ termLib: [], visualFidelityPlan: plan, outputSha256: sha }).visualFidelityPlan).toEqual(plan);
  });
  it("rejects duplicate inventory, invalid hashes and unbound optional fields", () => {
    expect(VisualFidelityPlan.safeParse({ ...plan, constraints: [constraint, constraint] }).success).toBe(false);
    expect(VisualFidelityPlan.safeParse({ ...plan, inputSha256: "not-hash" }).success).toBe(false);
    for (const input of [{ visualFidelityPlan: plan }, { outputSha256: sha }, { visualFidelityPlan: null }, { fidelitySourceImages: [] }]) {
      expect(ComplianceCheckRequest.safeParse({ termLib: [], ...input }).success).toBe(false);
    }
  });
  it("uses a separate version-bound report with explicit performed evidence", () => {
    const report = { revision: plan.revision, inputSha256: sha, outputSha256: sha, overall: "unknown", checkPerformed: false, checks: [{ id: "apple", status: "unknown", observation: "unread", evidence: "none" }], warnings: [] };
    expect(VisualFidelityReport.parse(report)).toEqual(report);
    expect(VisualFidelityReport.safeParse({ ...report, checkPerformed: "true" }).success).toBe(false);
    expect(VisualFidelityReport.safeParse({ ...report, checks: [{ ...report.checks[0], objectRegion: null }] }).success).toBe(false);
    expect(ComplianceCheckResponse.safeParse({ results: [], report: { overall: "PASS", textResults: [], visualResults: [], checkedAt: new Date().toISOString() }, visualFidelityReport: null }).success).toBe(false);
  });
});

it("mirrors source roles and Studio generation opt-in without changing legacy defaults", () => {
  const base = { sceneType: "SOCIAL_POSTER", sellingPoint: "green apple", scene: "", brandRules: [] };
  expect(GenerateRequest.parse(base)).not.toHaveProperty("visualFidelityRevision");
  expect(GenerateRequest.parse({ ...base, visualFidelityRevision: "visual-fidelity-guard/1" }).visualFidelityRevision).toBe("visual-fidelity-guard/1");
  expect(GenerateRequest.safeParse({ ...base, visualFidelityRevision: null }).success).toBe(false);
  expect(VisualFidelitySourceImage.parse({ url: "data:image/png;base64,AA==", sha256: sha, id: "ref", role: "reference-context", note: "只借鉴风格" }).role).toBe("reference-context");
  expect(VisualFidelitySourceImage.safeParse({ url: "x", sha256: sha, role: "original-product" }).success).toBe(false);
});

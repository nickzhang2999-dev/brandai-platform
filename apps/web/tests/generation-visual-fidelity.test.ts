import { describe, expect, it } from "vitest";
import { visualFidelityPresentation } from "../src/components/owned-canvas/GenerationVisualFidelity";
import type { VisualFidelityReport } from "@brandai/contracts";

const sha = "a".repeat(64);
const report: VisualFidelityReport = { revision: "visual-fidelity-guard/1", inputSha256: "b".repeat(64), outputSha256: sha, overall: "pass", checkPerformed: true,
  checks: [{ id: "subject", status: "pass", objectRegion: "左侧苹果", observation: "表皮保持绿色", evidence: "直接视觉核对" }], warnings: [] };
describe("subject fidelity display is output-bound", () => {
  it("does not infer success from a missing historical report", () => {
    expect(visualFidelityPresentation(null, sha)).toMatchObject({ status: "unknown", current: false });
  });
  it("accepts the current performed report", () => {
    expect(visualFidelityPresentation(report, sha).status).toBe("pass");
  });
  it("hides stale checks rather than showing a previous pass or failure", () => {
    for (const overall of ["pass", "fail"] as const) expect(visualFidelityPresentation({ ...report, overall }, "c".repeat(64))).toMatchObject({ status: "unknown", current: false });
  });
  it("does not treat an unperformed check as pass", () => {
    expect(visualFidelityPresentation({ ...report, checkPerformed: false }, sha).status).toBe("unknown");
  });
  it("keeps explicit failures and no-applicable-constraint states separate", () => {
    expect(visualFidelityPresentation({ ...report, overall: "fail" }, sha).reason).toContain("图片已保留");
    expect(visualFidelityPresentation({ ...report, overall: "not_applicable", checkPerformed: false }, sha).status).toBe("not_applicable");
  });
});

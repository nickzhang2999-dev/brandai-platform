import { describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error {} }));
import { readFidelitySnapshot, reviewFidelity, type FidelitySnapshot } from "../src/lib/studio-visual-fidelity-review";
const inputSha256 = "a".repeat(64), outputSha256 = "b".repeat(64);
const snapshot: FidelitySnapshot = { revision: "visual-fidelity-guard/1", inputSha256, unavailableReason: null, editSource: null, imageTool: false, referenceImages: [],
  plan: { revision: "visual-fidelity-guard/1", inputSha256, constraints: [{ id: "apple", target: "左侧苹果", attribute: "color", expected: "绿色", strength: "hard", source: "user" }] } };
const report = { revision: "visual-fidelity-guard/1", inputSha256, outputSha256, overall: "pass", checkPerformed: true,
  checks: [{ id: "apple", status: "pass", objectRegion: "左侧苹果表皮", observation: "表皮绿色", evidence: "已读取输出并定位苹果表皮" }], warnings: [] };
describe("server subject fidelity aggregation", () => {
  it("keeps historical absence null and malformed snapshots unknown", () => {
    expect(readFidelitySnapshot(undefined).fidelitySnapshot).toBeNull();
    expect(reviewFidelity(null, outputSha256, report, false)).toBeNull();
    expect(reviewFidelity(readFidelitySnapshot({}).fidelitySnapshot, outputSha256, report, false)?.overall).toBe("unknown");
  });
  it("ignores claimed overall and evaluates hard failures", () => {
    expect(reviewFidelity(snapshot, outputSha256, { ...report, overall: "fail" }, false)?.overall).toBe("pass");
    expect(reviewFidelity(snapshot, outputSha256, { ...report, checks: [{ ...report.checks[0], status: "fail" }] }, false)?.overall).toBe("fail");
  });
  it.each([
    { checks: [] }, { checks: [...report.checks, ...report.checks] }, { checks: [{ ...report.checks[0], id: "other" }] },
    { checks: [{ ...report.checks[0], evidence: " " }] }, { checks: [{ ...report.checks[0], objectRegion: undefined }] },
    { checks: [{ ...report.checks[0], evidence: "整图色板绿色" }] }, { outputSha256: "c".repeat(64) }, { inputSha256: "c".repeat(64) }, { checkPerformed: false },
  ])("rejects insufficient or stale evidence %j", change => {
    expect(reviewFidelity(snapshot, outputSha256, { ...report, ...change }, false)?.overall).toBe("unknown");
  });
  it("cannot compare a source attribute without source bytes", () => {
    const sourcePlan = { ...snapshot, plan: { ...snapshot.plan!, constraints: [{ ...snapshot.plan!.constraints[0], source: "source" as const }] } };
    expect(reviewFidelity(sourcePlan, outputSha256, report, false)?.overall).toBe("unknown");
    expect(reviewFidelity(sourcePlan, outputSha256, report, true)?.overall).toBe("pass");
  });
  it("soft constraints cannot become hard failures", () => {
    const soft = { ...snapshot, plan: { ...snapshot.plan!, constraints: [{ ...snapshot.plan!.constraints[0], strength: "soft" as const }] } };
    const value = reviewFidelity(soft, outputSha256, { ...report, checks: [{ ...report.checks[0], status: "fail" }] }, false);
    expect(value?.overall).toBe("not_applicable"); expect(value?.warnings.length).toBe(1);
  });
  it("keeps a valid hard failure even when another hard constraint is missing", () => {
    const plan = { ...snapshot, plan: { ...snapshot.plan!, constraints: [...snapshot.plan!.constraints, { ...snapshot.plan!.constraints[0], id: "quantity" }] } };
    const value = reviewFidelity(plan, outputSha256, { ...report, checks: [{ ...report.checks[0], status: "fail" }] }, false);
    expect(value?.overall).toBe("fail");
    expect(value?.checks.map(check => check.status)).toEqual(["fail", "unknown"]);
  });
});

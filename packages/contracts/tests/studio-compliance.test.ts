import { describe, expect, it } from "vitest";
import { AsyncTaskKind, StudioGenerationComplianceInput, StudioGenerationComplianceView } from "../src";

const base = { taskId: "task", versionId: "version", status: "PENDING", progress: 0,
  expiresAt: "2026-10-09T12:06:00Z", checkedImageSha256: null, report: null, error: null, canRetry: false };
const report = { overall: "RISK", textResults: [], visualResults: [{ level: "RISK", reason: "Brand color differs" }], checkedAt: "2026-10-09T12:01:00Z", score: 82.5 };
describe("product compliance is a real task, not an assumed pass", () => {
  it("accepts only a project/version identity, never browser reports or user identity", () => {
    expect(StudioGenerationComplianceInput.parse({ projectId: "project", versionId: "version" })).toEqual({ projectId: "project", versionId: "version" });
    for (const extra of [{ userId: "other" }, { report }, { versionId: "version\n" }]) {
      expect(StudioGenerationComplianceInput.safeParse({ projectId: "project", versionId: "version", ...extra }).success).toBe(false);
    }
    expect(AsyncTaskKind.parse("STUDIO_COMPLIANCE")).toBe("STUDIO_COMPLIANCE");
  });
  it("distinguishes a completed risky check from a failed or missing check", () => {
    expect(StudioGenerationComplianceView.parse(base).report).toBeNull();
    expect(StudioGenerationComplianceView.parse({ ...base, status: "SUCCEEDED", progress: 100, report, checkedImageSha256: "a".repeat(64) }).report?.overall).toBe("RISK");
    expect(StudioGenerationComplianceView.parse({ ...base, status: "FAILED", error: "Checking service unavailable", canRetry: true }).report).toBeNull();
    expect(StudioGenerationComplianceView.parse({ ...base, taskId: null, expiresAt: null, status: "NOT_REQUESTED" }).taskId).toBeNull();
  });
  it.each([
    { status: "SUCCEEDED" }, { status: "FAILED" }, { status: "FAILED", error: "failed", report },
    { checkedImageSha256: "a".repeat(64) }, { status: "NOT_REQUESTED" }, { taskId: null },
    { expiresAt: null }, { progress: 100.5 }, { checkedImageSha256: "not-a-digest" },
  ])("rejects misleading check receipts %j", change => {
    expect(StudioGenerationComplianceView.safeParse({ ...base, ...change }).success).toBe(false);
  });
});

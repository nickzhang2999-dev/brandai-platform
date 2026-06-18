/**
 * C8 — RuleSnapshot web-BFF contract shape + null-vs-optional boundary.
 */
import { describe, expect, it } from "vitest";
import {
  CreateRuleSnapshotInput,
  RuleSnapshotSummary,
  RestoreRuleSnapshotResult,
} from "../src/rule-snapshot";

describe("RuleSnapshot contracts", () => {
  it("CreateRuleSnapshotInput requires a non-empty label, trims, caps length", () => {
    expect(CreateRuleSnapshotInput.safeParse({ label: "" }).success).toBe(false);
    expect(
      CreateRuleSnapshotInput.safeParse({ label: "v1", note: "why" }).success,
    ).toBe(true);
    expect(
      CreateRuleSnapshotInput.safeParse({ label: "a".repeat(121) }).success,
    ).toBe(false);
  });

  it("RuleSnapshotSummary accepts omitted optional note/createdById", () => {
    const r = RuleSnapshotSummary.safeParse({
      id: "s1",
      workspaceId: "w1",
      label: "春节大促 v1",
      ruleCount: 3,
      createdAt: new Date(0).toISOString(),
    });
    expect(r.success).toBe(true);
  });

  it("RuleSnapshotSummary rejects explicit null on optional fields (null-vs-optional lock)", () => {
    const r = RuleSnapshotSummary.safeParse({
      id: "s1",
      workspaceId: "w1",
      label: "v1",
      note: null,
      ruleCount: 0,
      createdAt: new Date(0).toISOString(),
    });
    expect(r.success).toBe(false);
  });

  it("RestoreRuleSnapshotResult shape", () => {
    expect(
      RestoreRuleSnapshotResult.safeParse({
        restored: 3,
        retired: 1,
        backupSnapshotId: "bk1",
      }).success,
    ).toBe(true);
  });
});

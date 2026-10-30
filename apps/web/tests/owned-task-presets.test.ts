import { describe, expect, it } from "vitest";
import { applyOwnedTaskPreset, OWNED_TASK_PRESETS } from "@/components/owned-canvas/owned-task-presets";
import type { ProjectContextDraft } from "@/components/owned-canvas/owned-project-context-session";
describe("optional project starting points preserve user decisions", () => {
  const draft: ProjectContextDraft = { facts: { goal: "", audience: "已确认受众", approvedCopy: "不可变更的准确文案", visualRequirements: "" },
    materials: [{ assetId: "asset", assetSha256: "a".repeat(64), role: "PRODUCT" }], master: { assetId: "master", assetSha256: "b".repeat(64) } };
  it("never overwrites confirmed fields, assets, master or audience when changing task type", () => {
    const first = applyOwnedTaskPreset(draft, "product");
    expect(first.facts.approvedCopy).toBe(draft.facts.approvedCopy); expect(first.facts.audience).toBe(draft.facts.audience);
    expect(first.materials).toEqual(draft.materials); expect(first.master).toEqual(draft.master);
    expect(applyOwnedTaskPreset(first, "packaging")).toEqual(first);
    expect(draft.facts.goal).toBe(""); expect(draft.facts.visualRequirements).toBe("");
  });
  it("keeps missing project facts unconfirmed and unknown task ids unchanged", () => {
    const blank = { ...draft, facts: { goal: "", audience: "", approvedCopy: "", visualRequirements: "" } };
    for (const preset of OWNED_TASK_PRESETS) {
      const next = applyOwnedTaskPreset(blank, preset.id);
      expect(next.facts.audience).toBe(""); expect(next.facts.approvedCopy).toBe("");
      expect(next.facts.goal).not.toBe("");
    }
    expect(applyOwnedTaskPreset(blank, "external-untrusted")).toBe(blank);
  });
});

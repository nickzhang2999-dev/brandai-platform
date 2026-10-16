import { describe, expect, it } from "vitest";
import type { BrandRule } from "../../../packages/contracts/src";
import { canEditKnowledge, knowledgePageLocation, ruleReplacementMessage, draftImportAttempt, restoredImportAttempt } from "../src/components/brand-knowledge/knowledge-state";

describe("knowledge workspace and mutation boundaries", () => {
  it("never falls back to a cookie for missing, blank or ambiguous explicit workspace", () => {
    for (const workspaceId of [undefined, "", " ", ["brand-a", "brand-b"], "a".repeat(129)]) {
      expect(() => knowledgePageLocation({ workspaceId })).toThrow();
    }
    const location = knowledgePageLocation({ workspaceId: "brand-a", embedded: "1", callbackUrl: "https://outside.example/" });
    expect(location.callback).toBe("/studio-brand-knowledge?workspaceId=brand-a&embedded=1");
    expect(location.returnUrl).toBe("/studio?workspaceId=brand-a#/brand");
    expect(knowledgePageLocation({ workspaceId: "brand&other=value" }).returnUrl).toContain("workspaceId=brand%26other%3Dvalue");
  });
  it("only editors and owners get mutations", () => {
    expect(canEditKnowledge("OWNER")).toBe(true); expect(canEditKnowledge("EDITOR")).toBe(true);
    expect(canEditKnowledge("VIEWER")).toBe(false); expect(canEditKnowledge("REVIEWER")).toBe(false); expect(canEditKnowledge(undefined)).toBe(false);
  });
  it("warns only about another enabled rule of the same category", () => {
    const rules = [{ id: "old", type: "copy", status: "CONFIRMED" }, { id: "graphic", type: "graphic", status: "CONFIRMED" }] as BrandRule[];
    expect(ruleReplacementMessage({ id: "new", type: "copy", status: "DRAFT" }, rules)).toContain("1 条规则");
    expect(ruleReplacementMessage({ id: "new", type: "font", status: "DRAFT" }, rules)).toBeNull();
    expect(ruleReplacementMessage({ id: "old", type: "copy", status: "CONFIRMED" }, rules)).toBeNull();
  });
  it("retains the exact uncertain request across draft changes and rejects corrupt pointers", () => {
    const old = { mutationId: "c309700d-d50d-4b7a-a836-158701975a71", expectedDraftRevision: 7 };
    expect(draftImportAttempt(restoredImportAttempt(JSON.stringify(old)), 8, () => "new-id")).toEqual(old);
    expect(draftImportAttempt(null, 8, () => "new-id")).toEqual({ mutationId: "new-id", expectedDraftRevision: 8 });
    for (const raw of ["oops", JSON.stringify({ ...old, expectedDraftRevision: 0 }), JSON.stringify({ ...old, mutationId: "foreign" })]) expect(restoredImportAttempt(raw)).toBeNull();
  });
});

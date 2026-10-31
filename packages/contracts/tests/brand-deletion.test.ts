import { describe, it, expect } from "vitest";
import { BrandDeletionInput, BrandDeletionPreview, BrandDeletionResult } from "../src/brand-deletion";
const counts = { projects: 1, assets: 2, rules: 0, terms: 0, prohibitions: 0, inspirationCases: 0, members: 1 };
const preview = { workspaceId: "w", name: "品牌", counts, activeTasks: 0, canDelete: true, blockedReason: null, confirmationToken: "a".repeat(64) };
const input = { confirmationName: "品牌", confirmationToken: "a".repeat(64), mutationId: "ad717f54-3ddd-4afd-8aca-392ab1624656" };
describe("brand deletion boundaries", () => {
  it("accepts a precise preview, confirmed request and scoped local destination", () => {
    BrandDeletionPreview.parse(preview); BrandDeletionInput.parse(input);
    BrandDeletionResult.parse({ ok: true, deletedWorkspaceId: "w", nextWorkspaceId: "next", redirectTo: "/studio?workspaceId=next#/home" });
    BrandDeletionResult.parse({ ok: true, deletedWorkspaceId: "w", nextWorkspaceId: null, redirectTo: "/studio" });
  });
  it.each([{ activeTasks: 1 }, { canDelete: false }, { blockedReason: "blocked" }, { counts: { ...counts, projects: -1 } }, { counts: { ...counts, assets: "2" } }, { ownerId: "other" }])("rejects inconsistent preview %j", patch => {
    expect(BrandDeletionPreview.safeParse({ ...preview, ...patch }).success).toBe(false);
  });
  it.each([{ confirmationName: "" }, { confirmationToken: "" }, { mutationId: "not-uuid" }, { force: true }])("rejects unconfirmed request %j", patch => {
    expect(BrandDeletionInput.safeParse({ ...input, ...patch }).success).toBe(false);
  });
  it.each(["https://evil.invalid", "//evil.invalid", "/studio?workspaceId=other#/home", "/projects/old"])("rejects a mismatched destination %s", redirectTo => {
    expect(BrandDeletionResult.safeParse({ ok: true, deletedWorkspaceId: "w", nextWorkspaceId: "next", redirectTo }).success).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
vi.mock("../../../packages/db/src/index", () => ({ prisma: {} }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { BrandKitRecognizeInput, BrandKitParseManualInput, RecognizeRequest, ParseManualRequest, type BrandRule } from "@brandai/contracts";
import { brandKitTaskId, brandKitAssetIdentity, assertBrandKitAssetReusable, classifyBrandKitRule } from "@/lib/brand-kit-import";
import { groupBrandKitRules, uniqueBrandKitFiles } from "../src/components/brand-knowledge/brand-kit-state";

const mutationId = "e4e4c9c8-a2e7-4ea8-b85b-99463a11fc51";
describe("Brand Kit optional intent, source grouping and stable import identities", () => {
  it("keeps old all-category requests unchanged and permits explicit selected categories", () => {
    expect(BrandKitRecognizeInput.parse({ assetIds: ["asset"] })).toEqual({ assetIds: ["asset"] });
    expect(BrandKitParseManualInput.parse({ assetId: "pdf" })).toEqual({ assetId: "pdf" });
    expect(RecognizeRequest.parse({ assets: [{ id: "asset", url: "https://example.invalid/a" }] }).targetType).toBeUndefined();
    expect(ParseManualRequest.parse({ url: "https://example.invalid/doc", targetType: "layout" }).targetType).toBe("layout");
    expect(BrandKitRecognizeInput.parse({ assetIds: ["asset"], mutationId, targetType: "logo" })).toMatchObject({ mutationId, targetType: "logo" });
  });
  it.each([null, "LOGO", "admin", "", 1])("rejects invalid explicit classification %s on both BFF and AI wire", targetType => {
    for (const [schema, input] of [[BrandKitRecognizeInput, { assetIds: ["asset"] }], [BrandKitParseManualInput, { assetId: "pdf" }],
      [RecognizeRequest, { assets: [{ id: "asset", url: "https://example.invalid/a" }] }], [ParseManualRequest, { url: "https://example.invalid/pdf" }]] as const) {
      expect(schema.safeParse({ ...input, targetType }).success).toBe(false);
    }
  });
  it("does not discard or relabel the content of a mismatched model suggestion", () => {
    const rule = { type: "layout" as const, value: { grid: "6 columns" }, summary: "建议", evidence: [{ assetId: "source", page: 3, sourceRef: "crop-a" }] };
    expect(classifyBrandKitRule(rule)).toBe(rule);
    expect(classifyBrandKitRule(rule, "layout")).toBe(rule);
    const selected = classifyBrandKitRule(rule, "logo");
    expect(selected.type).toBe("logo"); expect(selected.value).toEqual({ analysisSuggestion: { type: "layout", value: rule.value } });
    expect(selected.evidence[0]).toEqual(rule.evidence[0]); expect(selected.evidence).toHaveLength(2);
    expect(rule.type).toBe("layout"); expect(rule.evidence).toHaveLength(1);
  });
  it("groups all suggestions from the same source and category without deleting advice", () => {
    const rule = (id: string, type: string, ids: string[]) => ({ id, type, evidence: ids.map(assetId => ({ assetId })) } as BrandRule);
    const rows = [rule("a", "logo", ["x"]), rule("b", "logo", ["x", "x"]), rule("c", "font", ["x"]), rule("d", "logo", ["y"]), rule("e", "logo", []), rule("f", "logo", [])];
    const groups = groupBrandKitRules(rows); expect(groups).toHaveLength(5);
    expect(groups[0]?.rules.map(row => row.id)).toEqual(["a", "b"]);
    expect(groups.flatMap(group => group.rules)).toHaveLength(rows.length);
  });
  it("deduplicates selected bytes even when filenames differ, but not different files", async () => {
    const one = new File(["same bytes"], "a.png", { type: "image/png" });
    const result = await uniqueBrandKitFiles([one, new File(["same bytes"], "b.png"), new File(["other"], "a.png")]);
    expect(result.duplicates).toBe(1); expect(result.files).toHaveLength(2); expect(result.files[0]).toBe(one);
  });
  it("binds upload identity to bytes, actor, workspace, category and folder", () => {
    const args = ["workspace", "user", Buffer.from("same"), "LOGO", null] as const;
    const original = brandKitAssetIdentity(...args);
    expect(brandKitAssetIdentity(...args)).toEqual(original);
    for (const changed of [["other", "user", args[2], "LOGO", null], ["workspace", "other", args[2], "LOGO", null],
      ["workspace", "user", Buffer.from("new"), "LOGO", null], ["workspace", "user", args[2], "KV", null], ["workspace", "user", args[2], "LOGO", "folder"]] as const)
      expect(brandKitAssetIdentity(...changed).id).not.toBe(original.id);
    expect(brandKitTaskId("w", "u", "RECOGNIZE", mutationId)).not.toBe(brandKitTaskId("w", "other", "RECOGNIZE", mutationId));
  });
  it("never resurrects or changes an existing disabled or recategorized asset", () => {
    const row = { workspaceId: "w", category: "LOGO", libraryKind: "BRAND_KIT", folderId: null, deprecatedAt: null, availableForGeneration: true };
    expect(() => assertBrandKitAssetReusable(row, "w", "LOGO", null)).not.toThrow();
    for (const patch of [{ deprecatedAt: new Date() }, { availableForGeneration: false }, { category: "OTHER" }, { libraryKind: "MATERIAL" }, { folderId: "other" }, { workspaceId: "foreign" }])
      expect(() => assertBrandKitAssetReusable({ ...row, ...patch }, "w", "LOGO", null)).toThrow("不会自动覆盖");
  });
});

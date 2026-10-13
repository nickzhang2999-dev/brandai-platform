import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ asset: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { asset: { findMany: f.asset } } }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { assertRuleAssetsInWorkspace, validatedRuleStructured } from "../../../apps/web/src/lib/brand-knowledge-safety";
import { loadAssetUrlMap } from "../../../apps/web/src/lib/prohibitions";
beforeEach(() => { vi.resetAllMocks(); f.asset.mockResolvedValue([]); });
describe("brand knowledge asset ownership", () => {
  it("checks both evidence and structured logo against the owning workspace, deduplicated", async () => {
    f.asset.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    await assertRuleAssetsInWorkspace({ asset: { findMany: f.asset } } as any, "w", { evidence: [{ assetId: "a" }, { assetId: "a" }], structured: { primary_logo_asset_id: "b" } });
    expect(f.asset).toHaveBeenCalledWith({ where: { workspaceId: "w", id: { in: ["a", "b"] } }, select: { id: true } });
  });
  it("refuses missing/foreign asset references instead of trusting an ID", async () => {
    await expect(assertRuleAssetsInWorkspace({ asset: { findMany: f.asset } } as any, "w", { evidence: [{ assetId: "foreign" }] })).rejects.toMatchObject({ status: 400 });
  });
  it("does not interpret notes or unspecified fields as a reference", async () => {
    await assertRuleAssetsInWorkspace({ asset: { findMany: f.asset } } as any, "w", { evidence: [{ note: "a" }], structured: { extras: { assetId: "arbitrary" } } }); expect(f.asset).not.toHaveBeenCalled();
  });
  it("enforces module payload schema", () => {
    expect(validatedRuleStructured("font", { primary_font: "Example", module: "color" })).toEqual({ module: "font", primary_font: "Example" });
    expect(() => validatedRuleStructured("color", { palette: "wrong" })).toThrow();
  });
  it("also scopes legacy prohibition URL resolution, including old stored references", async () => {
    f.asset.mockResolvedValue([{ id: "a", url: "https://storage.invalid/a" }]);
    expect(await loadAssetUrlMap("w", ["a", "a", null])).toEqual({ a: "https://storage.invalid/a" });
    expect(f.asset).toHaveBeenCalledWith({ where: { workspaceId: "w", id: { in: ["a"] } }, select: { id: true, url: true } });
  });
});

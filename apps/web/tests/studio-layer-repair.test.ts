import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { requireStudioLayerRepairParent, inspectStudioLayerRepair, studioImageToolPixelEvidence } from "../src/lib/studio-layer-repair";
const source = { shapeId: "shape:source", assetId: "source", sha256: "a".repeat(64), width: 96, height: 64 };
const parent = { id: "parent", workspaceId: "w", projectId: "p", status: "SUCCEEDED", sourceShapeId: source.shapeId,
  assetId: source.assetId, assetSha256: source.sha256, sourceWidth: source.width, sourceHeight: source.height };
const context = { decompositionRequestId: "parent", sourceShapeId: source.shapeId, assetId: source.assetId,
  assetSha256: source.sha256, width: source.width, height: source.height, mode: "inferred-completion", independentQuality: "NOT_REVIEWED" };
const find = vi.fn(), lock = vi.fn(), db: any = { studioDecompositionRequest: { findFirst: find }, $queryRaw: lock };
beforeEach(() => { vi.resetAllMocks(); find.mockResolvedValue(parent); });
describe("layer repair provenance (synthetic DB fixtures, zero provider calls)", () => {
  it("scopes a completed parent and never confuses inferred completion with visual approval", async () => {
    await expect(requireStudioLayerRepairParent(db, "w", "p", "parent", source)).resolves.toEqual(context);
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "parent", workspaceId: "w", projectId: "p", status: "SUCCEEDED" } }));
    expect(lock).not.toHaveBeenCalled();
  });
  it.each([{ workspaceId: "other" }, { projectId: "other" }, { id: "other" }, { status: "RUNNING" },
    { assetId: "extracted-layer" }, { assetSha256: "b".repeat(64) }, { sourceShapeId: "shape:replacement" },
    { sourceWidth: 95 }, { sourceHeight: 63 }])("rejects a forged, unfinished or mismatched parent %j", async patch => {
    find.mockResolvedValue({ ...parent, ...patch });
    await expect(requireStudioLayerRepairParent(db, "w", "p", "parent", source)).rejects.toMatchObject({ status: 409 });
  });
  it("blocks a parent removed while queued and locks it for final publication", async () => {
    await expect(inspectStudioLayerRepair(db, "w", "p", context, source, "inpaint", true)).resolves.toEqual(context);
    expect(lock).toHaveBeenCalledTimes(1); expect(lock.mock.invocationCallOrder[0]).toBeLessThan(find.mock.invocationCallOrder[0]);
    find.mockResolvedValue(null);
    await expect(inspectStudioLayerRepair(db, "w", "p", context, source, "inpaint")).rejects.toMatchObject({ status: 409 });
  });
  it("rejects malformed frozen context, a changed source or a different tool before looking up the parent", async () => {
    for (const [value, snapshot, operation] of [[{ ...context, mode: "recovered-original" }, source, "inpaint"],
      [context, { ...source, assetId: "other" }, "inpaint"], [context, null, "inpaint"], [context, source, "remove-background"]] as const) {
      await expect(inspectStudioLayerRepair(db, "w", "p", value, snapshot, operation)).rejects.toMatchObject({ status: 409 });
    }
    expect(find).not.toHaveBeenCalled();
  });
});
describe("bounded pixel protection evidence", () => {
  const evidence = { sourcePixelProtection: "outside-mask", protectedPixelCount: 6000, editedPixelCount: 144,
    maskSha256: "b".repeat(64), independentQuality: "not-reviewed" };
  it("keeps only validated internal evidence; no provider text, URL or key is copied", () => {
    expect(studioImageToolPixelEvidence("inpaint", { ...evidence, secret: "not-a-real-secret", url: "https://unit.invalid" }, 96, 64))
      .toEqual({ imageToolPixelEvidence: evidence });
  });
  it.each([{}, { ...evidence, editedPixelCount: -1 }, { ...evidence, protectedPixelCount: 6100 },
    { ...evidence, editedPixelCount: 1.5 }, { ...evidence, maskSha256: "unknown" }, { ...evidence, independentQuality: "approved" }])
    ("does not invent proof for missing or inconsistent evidence %j", value => {
      expect(studioImageToolPixelEvidence("inpaint", value, 96, 64)).toEqual({});
    });
  it("never attaches inpaint evidence to cutout or a resized result", () => {
    expect(studioImageToolPixelEvidence("remove-background", evidence, 96, 64)).toEqual({});
    expect(studioImageToolPixelEvidence("inpaint", evidence, 192, 128)).toEqual({});
  });
  it("records a full white mask truthfully as zero protected pixels", () => {
    const fullMask = { ...evidence, protectedPixelCount: 0, editedPixelCount: 96 * 64 };
    expect(studioImageToolPixelEvidence("inpaint", fullMask, 96, 64)).toEqual({ imageToolPixelEvidence: fullMask });
  });
});

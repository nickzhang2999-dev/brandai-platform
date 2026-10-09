import { describe, expect, it, vi } from "vitest";
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { assertStudioExactRasterBudget, deriveStudioExactLayout, type StudioExactReference } from "../../../apps/web/src/lib/studio-exact-geometry";

const sha = "a".repeat(64);
const shape = (id: string, type: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, typeName: "shape", type, x: 0, y: 0, rotation: 0, parentId: "page:one", index: "a1", opacity: 1, meta: {}, props, ...extra });
function fixture() {
  const store: Record<string, any> = {
    "page:one": { id: "page:one", typeName: "page", name: "Page", index: "a1" },
    "shape:frame": shape("shape:frame", "frame", { w: 1000, h: 500, name: "Frame", color: "white" }, { index: "a0" }),
    "shape:image": shape("shape:image", "c-image", { w: 200, h: 100, url: "/authoritative/image", radius: 0 }, { x: 100, y: 100 }),
  };
  const references: StudioExactReference[] = [{ shapeId: "shape:image", assetId: "asset-1", sha256: sha, width: 100, height: 50 }];
  return { store, references, outputFrameId: "shape:frame", outputWidth: 2000, outputHeight: 1000 };
}
const rotate = (x: number, y: number, angle: number) => ({ x: Math.cos(angle) * x - Math.sin(angle) * y, y: Math.sin(angle) * x + Math.cos(angle) * y });

describe("saved native EXACT geometry (pure computation, no provider or storage)", () => {
  it("derives image center and original aspect from saved props instead of invented placement", () => {
    const input = fixture(), before = JSON.stringify(input), result = deriveStudioExactLayout(input);
    expect(result.target).toEqual({ width: 2000, height: 1000 });
    expect(result.frame).toEqual({ shapeId: "shape:frame", width: 1000, height: 500, pageId: "page:one", pageTransform: [1, 0, 0, 1, 0, 0] });
    expect(result.layers[0]).toMatchObject({ shapeId: "shape:image", assetId: "asset-1", sha256: sha, width: 100, height: 50, displayWidth: 200, displayHeight: 100, relativeTransform: [1, 0, 0, 1, 100, 100],
      transform: { xRatio: 0.2, yRatio: 0.3, widthRatio: 0.2, rotationDeg: 0, flipX: false, zIndex: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 } } });
    expect(result.assetUsages[0]).toEqual({ assetId: "asset-1", mode: "EXACT", order: 0, exactTransform: result.layers[0]!.transform });
    expect(JSON.stringify(input)).toBe(before);
  });
  it("uses F inverse times I for independently rotated frame/image page branches", () => {
    const input = fixture(); Object.assign(input.store["shape:frame"], { x: 100, y: 0, rotation: Math.PI / 2 });
    Object.assign(input.store["shape:image"], { x: 50, y: 200, rotation: Math.PI / 2 }); input.store["shape:image"].props.w = 100; input.store["shape:image"].props.h = 50;
    const layer = deriveStudioExactLayout(input).layers[0]!;
    layer.relativeTransform.forEach((value, index) => expect(value).toBeCloseTo([1, 0, 0, 1, 200, 50][index]!, 10));
    expect(layer.transform.xRatio).toBeCloseTo(0.25); expect(layer.transform.yRatio).toBeCloseTo(0.15); expect(layer.transform.rotationDeg).toBeCloseTo(0);
  });
  it("composes rotated parent groups and rotates image center around the native local origin", () => {
    const input = fixture();
    input.store["shape:outer"] = shape("shape:outer", "group", {}, { x: 300, y: 200, rotation: Math.PI / 2, index: "a0" });
    Object.assign(input.store["shape:frame"], { parentId: "shape:outer", x: 20, y: 40, rotation: Math.PI / 4 });
    input.store["shape:inner"] = shape("shape:inner", "group", {}, { parentId: "shape:frame", x: 100, y: 80, rotation: Math.PI / 4 });
    Object.assign(input.store["shape:image"], { parentId: "shape:inner", x: 30, y: 20, rotation: -Math.PI / 6 });
    const result = deriveStudioExactLayout(input), layer = result.layers[0]!;
    const imageCenter = rotate(100, 50, -Math.PI / 6), groupCenter = rotate(30 + imageCenter.x, 20 + imageCenter.y, Math.PI / 4);
    expect(layer.transform.xRatio).toBeCloseTo((100 + groupCenter.x) / 1000, 10); expect(layer.transform.yRatio).toBeCloseTo((80 + groupCenter.y) / 500, 10);
    expect(layer.transform.rotationDeg).toBeCloseTo(15, 10);
    expect(result.frame.pageTransform[4]).toBeCloseTo(260); expect(result.frame.pageTransform[5]).toBeCloseTo(220);
  });
  it("supports ordinary parent frames without inventing clipping absent from the captured frame util", () => {
    const input = fixture(); input.store["shape:container"] = shape("shape:container", "frame", { w: 20, h: 20 }, { x: 80, y: 90 });
    Object.assign(input.store["shape:image"], { parentId: "shape:container", x: 20, y: 10 });
    expect(deriveStudioExactLayout(input).layers[0]!.transform).toMatchObject({ xRatio: 0.2, yRatio: 0.3 });
  });
  it.each([[false, true], [true, true], [true, false]])("preserves every corner under flipX=%s flipY=%s using rotation/flip algebra", (flipX, flipY) => {
    const input = fixture(); input.store["shape:image"].props.flipX = flipX; input.store["shape:image"].props.flipY = flipY; input.store["shape:image"].rotation = Math.PI / 6;
    const layer = deriveStudioExactLayout(input).layers[0]!;
    for (const [x, y] of [[-100, -50], [100, -50], [100, 50], [-100, 50]]) {
      const native = rotate(flipX ? -x! : x!, flipY ? -y! : y!, Math.PI / 6);
      const exact = rotate(layer.transform.flipX ? -x! : x!, y!, layer.transform.rotationDeg * Math.PI / 180);
      expect(exact.x).toBeCloseTo(native.x, 10); expect(exact.y).toBeCloseTo(native.y, 10);
    }
  });
  it("preserves saved hierarchical stacking independent of request order or child-only indexes", () => {
    const input = fixture();
    input.store["shape:bottom"] = shape("shape:bottom", "group", {}, { index: "a1" });
    input.store["shape:top"] = shape("shape:top", "group", {}, { index: "a2" });
    Object.assign(input.store["shape:image"], { parentId: "shape:bottom", index: "z9" });
    input.store["shape:second"] = shape("shape:second", "c-image", { w: 100, h: 50 }, { parentId: "shape:top", index: "a0", x: 200, y: 100 });
    input.references.unshift({ shapeId: "shape:second", assetId: "asset-2", sha256: "b".repeat(64), width: 100, height: 50 });
    const result = deriveStudioExactLayout(input);
    expect(result.layers.map(layer => layer.shapeId)).toEqual(["shape:image", "shape:second"]);
    expect(result.assetUsages.map(usage => [usage.assetId, usage.order])).toEqual([["asset-1", 0], ["asset-2", 1]]);
    expect(result.layers.map(layer => layer.transform.zIndex)).toEqual([0, 1]);
  });
  it("accepts native identity crop and zero adjustment defaults", () => {
    const input = fixture(); input.store["shape:image"].props.cropRegion = { x: 0, y: 0, w: 1, h: 1 };
    input.store["shape:image"].props.adjust = { light: 0, saturation: 0, contrast: 0 };
    expect(deriveStudioExactLayout(input).layers[0]!.transform.crop).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
  });
  it("allows only output pixel rounding of the selected frame aspect", () => {
    const input = fixture(); input.store["shape:frame"].props.w = 300; input.store["shape:frame"].props.h = 200; input.outputWidth = 1024; input.outputHeight = 683;
    expect(deriveStudioExactLayout(input).target.height).toBe(683);
    input.outputHeight = 685; expect(() => deriveStudioExactLayout(input)).toThrow(/比例/);
  });
  it("keeps representable partial overflow and rejects completely outside layers", () => {
    const input = fixture(); input.store["shape:image"].x = -150;
    expect(deriveStudioExactLayout(input).layers[0]!.transform.xRatio).toBeCloseTo(-0.05);
    input.store["shape:image"].x = 1100; expect(() => deriveStudioExactLayout(input)).toThrow(/完全位于/);
  });
  it("rejects a rotated layer with overlapping bounding boxes but no actual frame intersection", () => {
    const input = fixture(); input.store["shape:frame"].props = { w: 100, h: 100 }; input.outputWidth = input.outputHeight = 1000;
    Object.assign(input.store["shape:image"], { x: -20, y: -20 - 20 * Math.sqrt(2), rotation: Math.PI / 4 }); input.store["shape:image"].props = { w: 40, h: 40 };
    input.references[0]!.width = input.references[0]!.height = 40;
    expect(() => deriveStudioExactLayout(input)).toThrow(/完全位于/);
  });
  it("rejects unsupported crop, color adjustment and rounded image masks", () => {
    for (const props of [{ cropRegion: { x: 0.1, y: 0, w: 0.9, h: 1 } }, { adjust: { saturation: 0.1 } }, { adjust: { futureFilter: 0 } }, { radius: 5 }]) {
      const input = fixture(); Object.assign(input.store["shape:image"].props, props); expect(() => deriveStudioExactLayout(input)).toThrow();
    }
  });
  it("rejects nonuniform source stretching rather than treating visible width as the original aspect", () => {
    const input = fixture(); input.store["shape:image"].props.h = 120; expect(() => deriveStudioExactLayout(input)).toThrow(/非等比/);
  });
  it.each([{ scale: 2 }, { scaleX: 1.1 }, { transform: [1, 0, 0, 1, 0, 0] }, { clipChildren: true }, { mask: "mask-id" }])("rejects extra container scale or clipping %j", props => {
    const input = fixture(); input.store["shape:group"] = shape("shape:group", "group", props); input.store["shape:image"].parentId = "shape:group";
    expect(() => deriveStudioExactLayout(input)).toThrow();
  });
  it.each([0, 0.5, "1", null])("rejects image or ancestor opacity %j", opacity => {
    const input = fixture(); input.store["shape:group"] = shape("shape:group", "group", {}, { opacity }); input.store["shape:image"].parentId = "shape:group";
    expect(() => deriveStudioExactLayout(input)).toThrow(/不透明度/);
  });
  it("rejects temporary hiding, unknown parents and flipped containers", () => {
    const input = fixture(); input.store["shape:frame"].meta.agentHiddenUntilFit = true; expect(() => deriveStudioExactLayout(input)).toThrow(/加载/);
    delete input.store["shape:frame"].meta.agentHiddenUntilFit;
    input.store["shape:group"] = shape("shape:group", "c-mockup", { w: 100, h: 100 }); input.store["shape:image"].parentId = "shape:group";
    expect(() => deriveStudioExactLayout(input)).toThrow(/父级容器/);
    input.store["shape:group"].type = "group"; input.store["shape:group"].props.flipY = true; expect(() => deriveStudioExactLayout(input)).toThrow(/容器翻转/);
  });
  it("rejects missing parents, cycles and images on another page", () => {
    const input = fixture(); input.store["shape:image"].parentId = "shape:missing"; expect(() => deriveStudioExactLayout(input)).toThrow();
    input.store["shape:cycle"] = shape("shape:cycle", "group", {}, { parentId: "shape:cycle" }); input.store["shape:image"].parentId = "shape:cycle"; expect(() => deriveStudioExactLayout(input)).toThrow(/循环/);
    input.store["page:two"] = { id: "page:two", typeName: "page" }; input.store["shape:image"].parentId = "page:two"; expect(() => deriveStudioExactLayout(input)).toThrow(/同一页面/);
  });
  it("rejects invalid saved coordinates, sizes and source digests", () => {
    for (const change of [(input: any) => { input.store["shape:image"].x = NaN; }, (input: any) => { input.store["shape:image"].rotation = Infinity; }, (input: any) => { input.store["shape:image"].props.w = -1; }, (input: any) => { input.references[0].width = 0; }, (input: any) => { input.references[0].sha256 = "client-assertion"; }]) {
      const input = fixture(); change(input); expect(() => deriveStudioExactLayout(input)).toThrow();
    }
  });
  it("rejects unsupported frames, duplicated materials and ambiguous native indexes", () => {
    const input = fixture(); input.store["shape:frame"].type = "c-frame"; expect(() => deriveStudioExactLayout(input)).toThrow(/画框/); input.store["shape:frame"].type = "frame";
    input.references.push({ ...input.references[0]! }); expect(() => deriveStudioExactLayout(input)).toThrow(/重复/); input.references.pop();
    input.store["shape:second"] = shape("shape:second", "c-image", { w: 100, h: 50 }, { x: 200, y: 100, index: "a1" });
    input.references.push({ shapeId: "shape:second", assetId: "asset-2", sha256: sha, width: 100, height: 50 }); expect(() => deriveStudioExactLayout(input)).toThrow(/排序重复/);
  });
  it("rejects partial overflow beyond the existing EXACT width/center contract", () => {
    const input = fixture(); Object.assign(input.store["shape:image"], { x: -400, y: -500 }); Object.assign(input.store["shape:image"].props, { w: 3200, h: 1600 });
    expect(() => deriveStudioExactLayout(input)).toThrow(/支持范围/);
  });
  it("rejects oversized scaled rasters before a provider can be called", () => {
    const input = fixture(); input.outputWidth = 8000; input.outputHeight = 4000;
    Object.assign(input.store["shape:image"], { x: -500, y: -250 }); Object.assign(input.store["shape:image"].props, { w: 2000, h: 1000 });
    expect(() => deriveStudioExactLayout(input)).toThrow(/当前输出尺寸下过大/);
  });
  it("checks the full rotated raster, even when most pixels would later be clipped", () => {
    const input = fixture(); input.outputWidth = 10000; input.outputHeight = 1000; input.store["shape:frame"].props.h = 100;
    input.references[0]!.width = 1000; input.references[0]!.height = 100;
    const offset = rotate(750, 75, Math.PI / 4);
    Object.assign(input.store["shape:image"], { x: 500 - offset.x, y: 50 - offset.y, rotation: Math.PI / 4 }); Object.assign(input.store["shape:image"].props, { w: 1500, h: 150 });
    expect(() => deriveStudioExactLayout(input)).toThrow(/当前输出尺寸下过大/);
  });
  it("counts authoritative source pixels even when the saved display is a small thumbnail", () => {
    const input = fixture(); input.references[0]!.width = 8800; input.references[0]!.height = 4400;
    expect(() => deriveStudioExactLayout(input)).toThrow(/合计超过4000万像素/);
  });
  it("shares total decode and transformed raster guards with persisted-snapshot preflight", () => {
    const transform = deriveStudioExactLayout(fixture()).layers[0]!.transform;
    expect(() => assertStudioExactRasterBudget({ width: 2000, height: 1000 }, [{ width: 8000, height: 4750, transform }])).not.toThrow(); // Exactly 40M.
    expect(() => assertStudioExactRasterBudget({ width: 2000, height: 1000 }, [{ width: 6400, height: 3200, transform }, { width: 6400, height: 3200, transform }])).toThrow(/合计超过4000万像素/);
    expect(() => assertStudioExactRasterBudget({ width: 8000, height: 4000 }, [{ width: 100, height: 50, transform: { ...transform, widthRatio: 2 } }])).toThrow(/当前输出尺寸下过大/);
    expect(() => assertStudioExactRasterBudget({ width: 2000, height: 1000 }, [{ width: 100, height: 50, transform: { ...transform, rotationDeg: Infinity } }])).toThrow(/快照无效/);
  });
});

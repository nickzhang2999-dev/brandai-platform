import { describe, expect, it } from "vitest";
import { StudioConversationInput, StudioConversationDraftInput, StudioConversationPixels } from "../src/studio-conversation";
import { parseStudioConversationIntent } from "../../../apps/web/src/lib/studio-conversation-intent";

const one = { referenceId: "shape:one", shapeId: "shape:one", assetId: "a1", assetSha256: "a".repeat(64), name: "图片1", width: 1080, height: 1920 };
const two = { ...one, referenceId: "shape:two", shapeId: "shape:two", assetId: "a2", name: "图片2" };
const base = { mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", documentRevision: 1, workflowRevision: 0,
  text: "生成一张海报", references: [], sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" } };
const parse = (text: string, references: unknown[] = [], extra = {}) => parseStudioConversationIntent(StudioConversationInput.parse({ ...base, text, references, ...extra }));

describe("durable conversation contract and conservative action/size routing", () => {
  it("keeps old 1K/2K controls and strips no ownership fields", () => {
    expect(StudioConversationInput.parse(base).quickEditTargetId).toBeNull();
    for (const extra of [{ workspaceId: "foreign" }, { userId: "foreign" }, { imageUrl: "https://arbitrary" }, { acceptedCanvas: "x" }, { references: [{ ...one, url: "https://arbitrary" }] }]) expect(StudioConversationInput.safeParse({ ...base, ...extra }).success).toBe(false);
  });
  it("freezes unique ordered references with a valid quick target", () => {
    expect(StudioConversationInput.parse({ ...base, references: [two, one], quickEditTargetId: one.referenceId }).references.map(ref => ref.assetId)).toEqual(["a2", "a1"]);
    for (const references of [[one, one], [one, { ...two, assetId: one.assetId }], Array.from({ length: 9 }, (_, i) => ({ ...one, assetId: "a" + i, referenceId: "r" + i }))]) expect(StudioConversationInput.safeParse({ ...base, references }).success).toBe(false);
    expect(StudioConversationInput.safeParse({ ...base, quickEditTargetId: "missing" }).success).toBe(false);
  });
  it("rejects explicit optional null, floating revisions and invalid pixels", () => {
    for (const extra of [{ requestedSize: null }, { outputFrameId: null }, { documentRevision: 1.5 }, { references: [{ ...one, shapeId: null }] }, { text: "  " }]) expect(StudioConversationInput.safeParse({ ...base, ...extra }).success).toBe(false);
    for (const size of [{ width: 8192, height: 8192 }, { width: 1080, height: 32 }, { width: 1080.5, height: 1920 }]) expect(StudioConversationPixels.safeParse(size).success).toBe(false);
    expect(StudioConversationDraftInput.parse({ revision: 0, text: "", references: [one], sizeSelection: base.sizeSelection }).text).toBe("");
  });
  it("routes new images and explicit reference compositions to generation", () => {
    expect(parse("设计一张夏日海报").action).toBe("generate");
    const composite = parse("参考图片1和图片2，合成一张海报", [one, two]);
    expect(composite.action).toBe("generate"); expect(composite.referenceIds).toEqual([one.referenceId, two.referenceId]);
    expect(parse("用这张参考重新设计一张新图", [one]).action).toBe("generate");
  });
  it("pins a single image edit to original actual dimensions", () => {
    const intent = parse("背景改成蓝色", [one]);
    expect(intent.action).toBe("modify"); expect(intent.targetReferenceId).toBe(one.referenceId);
    expect(intent.requestedSize).toEqual({ width: 1080, height: 1920 }); expect(intent.sizeSource).toBe("target");
    expect(parse("重新修改图片1背景", [one]).action).toBe("modify");
  });
  it("separates an explicit target from ordered reference pictures", () => {
    const intent = parse("把图片2的背景改成图片1的风格", [one, two]);
    expect(intent.action).toBe("modify"); expect(intent.targetReferenceId).toBe(two.referenceId); expect(intent.referenceIds).toEqual([one.referenceId]);
  });
  it("clarifies multiple possible edit targets without a paid job", () => {
    expect(parse("背景改成蓝色", [one, two]).action).toBe("clarify");
    expect(parse("修改图片1，修改图片2", [one, two]).action).toBe("clarify");
    expect(parse("继续上一张", []).action).toBe("clarify");
    expect(parse("去掉背景", []).action).toBe("clarify");
  });
  it("does not let quick edit become a sourceless new generation", () => {
    const intent = parse("生成一张夜景海报", [one, two], { quickEditTargetId: two.referenceId });
    expect(intent.action).toBe("modify"); expect(intent.targetReferenceId).toBe(two.referenceId);
  });
  it("uses dialog pixels over the 1:1 control and records provenance", () => {
    for (const text of ["生成一张海报，1080×1920", "生成海报 1080*1920", "海报尺寸1080x1920像素"]) {
      const intent = parse(text); expect(intent.requestedSize).toEqual({ width: 1080, height: 1920 }); expect(intent.sizeSource).toBe("dialog-pixels");
    }
  });
  it("does not interpret printed copy as output dimensions", () => {
    for (const text of ["生成海报，写上1080×1920", "生成海报，标题为1080*1920", "生成海报，文案为“1080×1920”"]) expect(parse(text).requestedSize).toEqual({ width: 1024, height: 1024 });
  });
  it("handles dialog ratio/tier and conflicting or unsupported sizes", () => {
    const intent = parse("海报比例9:16，2K"); expect(intent.sizeSource).toBe("dialog-ratio"); expect(intent.sizeSelection).toEqual({ ratioKey: "9:16", resolutionTier: "2K" });
    for (const text of ["生成海报1080×1920和1024×1024", "生成海报1080×1920比例1:1", "生成海报8192×8192", "生成海报20cm×30cm", "生成海报4K", "生成海报1:1或者16:9"]) expect(parse(text).action).toBe("clarify");
  });
  it("never invents targets from an arbitrary previous result", () => {
    const input = StudioConversationInput.parse({ ...base, text: "继续上一张背景改成蓝色", references: [one] });
    expect(parseStudioConversationIntent(input, StudioConversationInput.parse({ ...base, references: [two] }).references[0]).action).toBe("clarify");
    expect(parseStudioConversationIntent(input, input.references[0]).action).toBe("modify");
  });
  it("clarifies EXACT references missing their output frame", () => {
    expect(parse("生成一张海报", [{ ...one, purpose: "EXACT" }]).action).toBe("clarify");
    expect(parse("生成一张海报", [{ ...one, purpose: "EXACT" }], { outputFrameId: "shape:frame" }).action).toBe("generate");
  });
});

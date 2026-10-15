import { describe, expect, it } from "vitest";
import { StudioConversationInput, StudioConversationDraftInput, StudioConversationPixels } from "../src/studio-conversation";
import { parseStudioConversationIntent } from "../../../apps/web/src/lib/studio-conversation-intent";

const one = { referenceId: "shape:one", shapeId: "shape:one", assetId: "a1", assetSha256: "a".repeat(64), name: "图片1", width: 1080, height: 1920 };
const two = { ...one, referenceId: "shape:two", shapeId: "shape:two", assetId: "a2", name: "图片2" };
const four = { ...one, referenceId: "shape:four", shapeId: "shape:four", assetId: "a4", name: "图片4" };
const forty = { ...one, referenceId: "shape:forty", shapeId: "shape:forty", assetId: "a40", name: "图片40" };
const base = { mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", documentRevision: 1, workflowRevision: 0,
  text: "生成一张海报", references: [], sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" } };
const parse = (text: string, references: unknown[] = [], extra = {}) => parseStudioConversationIntent(StudioConversationInput.parse({ ...base, text, references, ...extra }));

describe("durable conversation contract and conservative action/size routing", () => {
  it.each([
    "光影自然一点，阳光洒下", "构图保持不变，场景真实一点，阳光洒下来",
    "画面更真实", "背景再明亮一些", "色调温暖一点", "让阳光洒进窗户",
  ])("understands a concrete natural adjustment with one editable reference: %s", text => {
    const intent = parse(text, [four]);
    expect(intent.action).toBe("modify"); expect(intent.targetReferenceId).toBe(four.referenceId);
    expect(intent.prompt).toBe(text); expect(intent.sizeSource).toBe("target");
    expect(parse(text, [one, four]).action).toBe("clarify");
    expect(parse(`生成一张海报，${text}`, [one, four]).action).toBe("generate");
  });
  it.each([
    "光影很自然，阳光洒下", "阳光洒下", "光影自然一点吗？", "光影是不是更自然",
    "参考这个光影更自然的效果", "不要让光影更自然", "别让阳光洒下", "光影不用更自然",
    "构图保持不变，场景不要真实一点", "文案为“光影自然一点”",
    "文案为“欢迎回来，光影自然一点，春天到了”", "背景更明亮的照片很好看",
  ])("does not charge for visual commentary, questions, quotes or negation: %s", text => {
    expect(parse(text, [four]).action).toBe("clarify");
  });
  it("uses named natural targets without confusing image 4 with image 40", () => {
    expect(parse("图片40的光影自然一点", [four, forty]).targetReferenceId).toBe(forty.referenceId);
    expect(parse("图片4的场景真实一点，图片40作为参考", [four, forty]).targetReferenceId).toBe(four.referenceId);
    expect(parse("图片4光影自然一点，图片40场景真实一点", [four, forty]).action).toBe("clarify");
    expect(parse("场景真实一点", [{ ...four, shapeId: undefined }]).action).toBe("clarify");
  });
  it("preserves explicit target and size guards for natural editing", () => {
    expect(parse("光影自然一点", [one, four], { quickEditTargetId: four.referenceId }).targetReferenceId).toBe(four.referenceId);
    expect(parse("光影自然一点，1080×1920", [four]).requestedSize).toEqual({ width: 1080, height: 1920 });
    expect(parse("光影自然一点，20厘米", [four]).action).toBe("clarify");
    expect(parse("生成一张海报，光影自然一点", [{ ...four, purpose: "EXACT" }]).action).toBe("clarify");
    const input = StudioConversationInput.parse({ ...base, text: "光影自然一点", references: [four] });
    expect(parseStudioConversationIntent(input, undefined, { action: "modify", targetReferenceId: "missing" }).action).toBe("clarify");
  });
  it.each([
    "修改目标已失效、归属不符或原始配方发生变化，请重新选择图片。",
    "  修改目标已失效、归属不符或原始配方发生变化,\n请重新选择图片.  ",
    "这张历史生成图片缺少可验证的原始合成记录，暂不能继续改图。请选用新工作台生成的图片。",
    "修改目标在准备期间无法通过来源校验，未调用生成服务。请重新选择图片后提交。",
  ])("clarifies an echoed source notice instead of charging for its edit keyword: %s", text => {
    for (const references of [[], [four], [one, four]]) {
      const intent = parse(text, references);
      expect(intent.action).toBe("clarify"); expect(intent.targetReferenceId).toBeNull();
      expect(intent.clarification).toContain("不会据此发起新的模型调用");
    }
    const input = StudioConversationInput.parse({ ...base, text, references: [four], quickEditTargetId: four.referenceId });
    for (const decision of [undefined, { action: "modify" as const, targetReferenceId: four.referenceId }, { action: "generate" as const, targetReferenceId: null }])
      expect(parseStudioConversationIntent(input, undefined, decision).action).toBe("clarify");
  });
  it("allows a real request to quote the notice as image copy and preserves ordinary edits", () => {
    for (const notice of [
      "修改目标已失效、归属不符或原始配方发生变化，请重新选择图片。",
      "这张历史生成图片缺少可验证的原始合成记录，暂不能继续改图。请选用新工作台生成的图片。",
      "修改目标在准备期间无法通过来源校验，未调用生成服务。请重新选择图片后提交。",
    ]) {
      const text = `生成一张海报，文案为“${notice}”`;
      expect(parse(text, [four]).action).toBe("generate"); expect(parse(text, [four]).prompt).toBe(text);
    }
    expect(parse("把错误提示文字修改为欢迎回来", [four]).action).toBe("modify");
  });
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
  it.each([
    "构图保持不变，场景要有真实感，渲染光影，阳光洒下",
    "构图保持不变，场景替换为真实感场景，渲染光影",
    "保留原构图，增强光影",
    "保持构图不变，画面需要更有真实感",
    "场景替换成阳光下的真实街景",
  ])("routes clear scene/lighting adjustment to the only editable image: %s", text => {
    const intent = parse(text, [four]);
    expect(intent.action).toBe("modify"); expect(intent.targetReferenceId).toBe(four.referenceId);
    expect(intent.referenceIds).toEqual([]); expect(intent.sizeSource).toBe("target");
    expect(intent.requestedSize).toEqual({ width: four.width, height: four.height });
  });
  it.each([
    "阳光很好", "光影很好，场景很真实", "构图保持不变", "构图保持不变，阳光很好",
    "保留构图，参考这个渲染光影效果", "场景替换功能很好",
  ])("does not turn an attached image and visual commentary into a paid edit: %s", text => {
    const intent = parse(text, [four]); expect(intent.action).toBe("clarify"); expect(intent.targetReferenceId).toBeNull();
  });
  it.each([
    "构图保持不变，不需要渲染光影",
    "构图保持不变，不要增强光影",
    "构图保持不变，场景不需要真实感",
    "不要把场景替换为街景",
    "图片4不要场景替换为街景",
    "图片4无需场景替换为街景",
  ])("never charges from a negated new scene/lighting instruction: %s", text => {
    for (const refs of [[four], [four, forty]]) {
      const intent = parse(text, refs); expect(intent.action).toBe("clarify"); expect(intent.targetReferenceId).toBeNull();
    }
  });
  it("keeps affirmative scene changes separate from a negated lighting constraint", () => {
    const intent = parse("图片4场景替换为真实街景，不需要渲染光影", [four, forty]);
    expect(intent.action).toBe("modify"); expect(intent.targetReferenceId).toBe(four.referenceId);
    expect(parse("图片4场景替换为特别真实的街景，不需要渲染光影", [four, forty]).targetReferenceId).toBe(four.referenceId);
  });
  it.each([
    "构图保持不变，场景要有真实感，渲染光影，阳光洒下",
    "构图保持不变，场景替换为真实感场景，渲染光影",
  ])("still clarifies the same visual instruction with multiple unnamed targets: %s", text => {
    expect(parse(text, [one, four]).action).toBe("clarify");
  });
  it("resolves an explicit scene target and never matches a numeric name prefix", () => {
    for (const text of ["图片4的场景替换为真实感场景，参考图片40", "图片4构图保持不变，场景要有真实感，渲染光影"])
      expect(parse(text, [forty, four]).targetReferenceId).toBe(four.referenceId);
    const intent = parse("图片40场景替换为阳光下的街景", [four, forty]);
    expect(intent.action).toBe("modify"); expect(intent.targetReferenceId).toBe(forty.referenceId); expect(intent.referenceIds).toEqual([four.referenceId]);
    expect(parse("图片40场景替换为阳光下的街景", [four, one]).action).toBe("clarify");
    expect(parse("图片4场景替换为街景，图片40场景替换为海边", [four, forty]).action).toBe("clarify");
  });
  it("keeps explicit new-image generation ahead of visual edit hints", () => {
    for (const text of ["参考图片4，生成一张新图，构图保持不变，场景要有真实感，渲染光影", "设计一张新图，场景替换为真实感场景"])
      expect(parse(text, [four]).action).toBe("generate");
    expect(parse("生成一张新图，图片4场景替换为街景", [four, forty]).action).toBe("generate");
  });
  it.each([
    "生成一个海报，构图保持不变，渲染光影",
    "设计一幅新图，构图保持不变，场景要有真实感",
    "制作一个海报，图片4场景替换为真实街景",
    "生成1张海报，构图保持不变，渲染光影",
  ])("prioritizes explicit creation with a supported image count word: %s", text => {
    for (const refs of [[four], [four, forty]]) {
      const intent = parse(text, refs); expect(intent.action).toBe("generate"); expect(intent.targetReferenceId).toBeNull();
      expect(intent.referenceIds).toEqual(refs.map(ref => ref.referenceId));
    }
    expect(parse(text, [four, forty], { quickEditTargetId: four.referenceId }).targetReferenceId).toBe(four.referenceId);
  });
  it("never changes a forced quick-edit target to a named lighting reference", () => {
    const intent = parse("图片4构图保持不变，场景要有真实感，渲染光影", [one, four], { quickEditTargetId: one.referenceId });
    expect(intent.action).toBe("modify"); expect(intent.targetReferenceId).toBe(one.referenceId); expect(intent.referenceIds).toEqual([four.referenceId]);
  });
  it("requires an editable canvas target even for a clear visual instruction", () => {
    const { shapeId: _shapeId, ...brandOnly } = four;
    expect(parse("构图保持不变，场景要有真实感，渲染光影", [brandOnly]).action).toBe("clarify");
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

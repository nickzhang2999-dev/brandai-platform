import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioConversationInput } from "../../../packages/contracts/src/studio-conversation";
import { StudioConversationModelRequest, StudioConversationModelResponse } from "../../../packages/contracts/src/studio-conversation-model";
const f = vi.hoisted(() => ({ settings: vi.fn(), model: vi.fn() }));
vi.mock("../src/lib/settings", () => ({ getEffectiveAiSettings: f.settings }));
vi.mock("../src/lib/ai", () => ({ ai: { studioConversationIntent: f.model } }));
vi.mock("../src/lib/ai-service", () => ({ resolveAiService: vi.fn(async () => ({ studioConversationIntentRevision: "structured-conversation-intent-r1" })) }));
import { studioConversationModelAvailable, resolveStudioConversationModel, unknownStudioConversationIntent } from "../src/lib/studio-conversation-model";
import { parseStudioConversationIntent } from "../src/lib/studio-conversation-intent";
import { conversationChoiceOptions, intentFromConversationOption, withConversationChoices } from "../src/lib/studio-conversation-choices";
const ref = { referenceId: "shape:one", shapeId: "shape:one", name: "图片1", assetId: "a1", assetSha256: "a".repeat(64), width: 1080, height: 1920 };
const two = { ...ref, referenceId: "shape:two", shapeId: "shape:two", name: "图片2", assetId: "a2" };
const input = (extra = {}) => StudioConversationInput.parse({ mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", text: "调整图片2，参考图片1，1080×1920", documentRevision: 1,
  workflowRevision: 0, references: [ref, two], sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" }, ...extra });
const response = (decision = {}) => ({ revision: "structured-conversation-intent-r2", decision: { action: "modify", targetReferenceId: two.referenceId, referenceIds: [ref.referenceId], confidence: .95, clarification: null, imagePrompt: "保留图片2的主体构图，参考图片1调整画面光影。", options: [], ...decision } });
beforeEach(() => { vi.resetAllMocks(); delete process.env.STUDIO_CONVERSATION_INTENT_ENABLED; f.model.mockResolvedValue(response()); f.settings.mockResolvedValue({ vlm: { provider: "openai", apiKey: "fixture-unit-only" } }); });
describe("formal structured model adapter without any real provider calls", () => {
  it("never lets an inherited master override the explicit quick-edit target", async () => {
    const master = { referenceId: "project-context:master", assetId: "master", assetSha256: "b".repeat(64), name: "主稿", width: 1024, height: 1024, purpose: "REFERENCE" };
    const current = input({ text: "背景改成蓝色", references: [ref, master], quickEditTargetId: ref.referenceId, projectContextRevision: 1 });
    f.model.mockResolvedValue(response({ action: "modify", targetReferenceId: master.referenceId, referenceIds: [], imagePrompt: "改主稿背景" }));
    const context = { references: current.references.map(item => ({ referenceId: item.referenceId, name: item.name, editable: !!item.shapeId })), history: [], selectedReferenceIds: [],
      projectContext: { revision: 1, facts: { goal: "海报", audience: "", approvedCopy: "", visualRequirements: "" }, materials: [], masterReferenceId: master.referenceId } };
    await expect(resolveStudioConversationModel(current, undefined, AbortSignal.timeout(1000), context)).rejects.toThrow("Untrusted structured intent");
    expect(f.model.mock.calls[0][0].quickEditTargetId).toBe(ref.referenceId);
  });
  it.each([
    ["构图保持不变，场景要有真实感，渲染光影，阳光洒下", "modify"],
    ["小狐狸在家门口给小白鼠糖", "generate"],
    ["加一个海绵宝宝在最前面", "modify"],
    ["把背景换成蓝色", "modify"],
  ])("uses fixed r2 semantic fixtures without claiming live accuracy: %s", async (text, action) => {
    const current = input({ text, references: [ref] });
    const legacy = parseStudioConversationIntent(current);
    f.model.mockResolvedValue(response({ action, targetReferenceId: action === "modify" ? ref.referenceId : null,
      referenceIds: action === "modify" ? [] : [ref.referenceId], imagePrompt: text }));
    const result = await resolveStudioConversationModel(current, undefined, AbortSignal.timeout(1000));
    expect(result.action).toBe(action); expect(result.prompt).toBe(text); expect(result.imagePrompt).toBe(text);
    if (text.startsWith("加一个")) expect(legacy.action).toBe("generate");
  });
  it.each(["背景是不是太暗，先告诉我", "先别生成，只讨论背景", "不要修改背景", "这张很好看"])("prevents charges for %s", async text => {
    const current = input({ text });
    const result = await resolveStudioConversationModel(current, undefined, AbortSignal.timeout(1000));
    expect(result.action).toBe("clarify"); expect(f.model).not.toHaveBeenCalled(); expect(conversationChoiceOptions(current, result)).toEqual([]);
  });
  it("transports trusted visual/history context and records only numeric usage", async () => {
    const current = input({ selectedReferenceIds: [two.referenceId] });
    const thumbnail = { dataUrl: "data:image/png;base64,YQ==", width: 1, height: 1 };
    const context = { references: current.references.map(item => ({ referenceId: item.referenceId, name: item.name, editable: true, thumbnail })),
      history: [{ role: "user" as const, text: "上一轮描述", resultReferenceId: null }], selectedReferenceIds: [two.referenceId], lastResultImage: { name: "上张结果", thumbnail } };
    f.model.mockResolvedValue({ ...response(), usage: { inputTokens: 180, outputTokens: 60, totalTokens: 240, latencyMs: 250 } });
    const result = await resolveStudioConversationModel(current, undefined, AbortSignal.timeout(1000), context);
    expect(f.model.mock.calls[0]![0]).toMatchObject({ schemaVersion: 2, ...context }); expect(result.modelUsage?.totalTokens).toBe(240);
  });
  it("retains literal copy and rejects a rewrite that drops it", async () => {
    const current = input({ text: "修改图片2，标题写上“夏日，开始吧！”" });
    await expect(resolveStudioConversationModel(current, undefined, AbortSignal.timeout(1000))).rejects.toThrow("literal copy");
    f.model.mockResolvedValue(response({ imagePrompt: "修改图片2，标题逐字保留：夏日，开始吧！" }));
    expect((await resolveStudioConversationModel(current, undefined, AbortSignal.timeout(1000))).imagePrompt).toContain("夏日，开始吧！");
  });
  it("treats Chinese single-quoted hold words and dimensions as poster copy", async () => {
    const current = input({ text: "生成海报，标题写‘先别生成 1920×1080’，背景蓝色", references: [] });
    f.model.mockResolvedValue(response({ action: "generate", targetReferenceId: null, referenceIds: [], imagePrompt: "蓝色背景海报，标题逐字写：先别生成 1920×1080" }));
    const result = await resolveStudioConversationModel(current, undefined, AbortSignal.timeout(1000));
    expect(f.model).toHaveBeenCalledOnce(); expect(result.action).toBe("generate"); expect(result.requestedSize).toEqual({ width: 1024, height: 1024 });
  });
  it("offers bounded explicit choices for ambiguity and unavailable-model fallback", async () => {
    const current = input({ text: "这两张一起做一张海报" });
    const options = [
      { id: "new", label: "生成新图", action: "generate", targetReferenceId: null, referenceIds: [ref.referenceId, two.referenceId], imagePrompt: current.text },
      { id: "edit", label: "修改图片2", action: "modify", targetReferenceId: two.referenceId, referenceIds: [ref.referenceId], imagePrompt: current.text },
    ];
    f.model.mockResolvedValue(response({ action: "clarify", targetReferenceId: null, imagePrompt: null, clarification: "请选择目标", options }));
    const result = await resolveStudioConversationModel(current, undefined, AbortSignal.timeout(1000));
    expect(result.action).toBe("clarify"); expect(result.options).toEqual(options);
    const fallback = withConversationChoices(current, { ...parseStudioConversationIntent(current), modelStatus: "UNAVAILABLE" });
    expect(fallback.options).toHaveLength(3);
    f.model.mockResolvedValue(response({ action: "clarify", targetReferenceId: null, imagePrompt: null, clarification: "请选择目标", options: [{ ...options[0], referenceIds: ["foreign"] }, options[1]] }));
    await expect(resolveStudioConversationModel(current, undefined, AbortSignal.timeout(1000))).rejects.toThrow();
  });
  it("does not turn model or fallback choices into an EXACT/frame or size bypass", async () => {
    const current = input({ text: "生成新海报", references: [{ ...ref, purpose: "EXACT" }] });
    f.model.mockResolvedValue(response({ action: "generate", targetReferenceId: null, referenceIds: [ref.referenceId] }));
    const result = await resolveStudioConversationModel(current, undefined, AbortSignal.timeout(1000));
    expect(result.action).toBe("clarify"); expect(result.clarification).toContain("画框");
    expect(result.options?.some(option => option.action === "generate")).toBe(false);
    const contradictory = input({ text: "生成海报，1080×1920，比例1:1" });
    expect(conversationChoiceOptions(contradictory, parseStudioConversationIntent(contradictory))).toEqual([]);
  });
  it("rejects omitted non-target EXACT references in both model decisions and clickable options", async () => {
    const current = input({ references: [{ ...ref, purpose: "EXACT" }, two] });
    f.model.mockResolvedValue(response({ referenceIds: [] }));
    await expect(resolveStudioConversationModel(current, undefined, AbortSignal.timeout(1000))).rejects.toThrow("strict preservation");
    expect(() => intentFromConversationOption(current, { id: "edit", label: "修改图片2", action: "modify", targetReferenceId: two.referenceId,
      referenceIds: [], imagePrompt: current.text })).toThrow("strict preservation");
  });
  it("keeps a pinned target in low-confidence fallback choices; only explicit correction can switch action", async () => {
    const current = input({ quickEditTargetId: two.referenceId });
    f.model.mockResolvedValue(response({ confidence: .5 }));
    const result = await resolveStudioConversationModel(current, undefined, AbortSignal.timeout(1000));
    expect(result.action).toBe("clarify"); expect(result.options).toHaveLength(1); expect(result.options![0]!.targetReferenceId).toBe(two.referenceId);
    const complete = parseStudioConversationIntent(current);
    expect(conversationChoiceOptions(current, complete, true).map(option => option.action)).toEqual(["generate"]);
  });
  it.each(["不要生成一张海报", "光影是不是更自然", "这张怎么样？"])("refuses a non-actionable input before a semantic model call: %s", async text => {
    const result = await resolveStudioConversationModel(input({ text }), undefined, AbortSignal.timeout(1000));
    expect(result.action).toBe("clarify"); expect(f.model).not.toHaveBeenCalled();
  });
  it("preserves a model-resolved reference creation scene without generation keywords", async () => {
    f.model.mockResolvedValue(response({ action: "generate", targetReferenceId: null, referenceIds: [ref.referenceId] }));
    const result = await resolveStudioConversationModel(input({ text: "根据这张图，我需要小狐狸在家里开门给小白鼠糖", references: [ref] }), undefined, AbortSignal.timeout(1000));
    expect(result.action).toBe("generate"); expect(result.referenceIds).toEqual([ref.referenceId]);
    expect(f.model).toHaveBeenCalledOnce();
  });
  it("requires explicit activation and an existing nonmock VLM config", async () => {
    expect(await studioConversationModelAvailable()).toBe(false); expect(f.settings).not.toHaveBeenCalled();
    process.env.STUDIO_CONVERSATION_INTENT_ENABLED = "1"; expect(await studioConversationModelAvailable()).toBe(true);
    f.settings.mockResolvedValue({ vlm: { provider: "mock", apiKey: "fixture" } }); expect(await studioConversationModelAvailable()).toBe(false);
    delete process.env.STUDIO_CONVERSATION_INTENT_ENABLED;
  });
  it("requests bounded r2 context and keeps width-height resolution server authoritative", async () => {
    const result = await resolveStudioConversationModel(input(), undefined, AbortSignal.timeout(1000));
    expect(result.parser).toBe("structured-model-v2"); expect(result.modelStatus).toBe("SUCCEEDED"); expect(result.targetReferenceId).toBe(two.referenceId);
    expect(result.requestedSize).toEqual({ width: 1080, height: 1920 }); expect(result.referenceIds).toEqual([ref.referenceId]);
    expect(f.model).toHaveBeenCalledOnce(); const [request, options] = f.model.mock.calls[0]!; expect(request.providerRetryPolicy).toBe("never");
    expect(request.references[0]).toEqual({ referenceId: ref.referenceId, name: ref.name, editable: true }); expect(options.maxResponseBytes).toBe(96 * 1024);
    expect(request.schemaVersion).toBe(2); expect(request.history).toEqual([]); expect(result.prompt).toBe(input().text); expect(result.imagePrompt).toContain("主体构图");
  });
  it("rejects invented or mismatched targets after a single model call", async () => {
    for (const decision of [{ targetReferenceId: "foreign" }, { referenceIds: ["foreign"] }, { referenceIds: [two.referenceId] }]) {
      f.model.mockResolvedValue(response(decision)); await expect(resolveStudioConversationModel(input(), undefined, AbortSignal.timeout(1000))).rejects.toThrow();
    }
    f.model.mockResolvedValue(response({ action: "generate", targetReferenceId: null, referenceIds: [] }));
    await expect(resolveStudioConversationModel(input({ quickEditTargetId: ref.referenceId }), undefined, AbortSignal.timeout(1000))).rejects.toThrow();
  });
  it("turns low confidence into clarification and preserves contradictory size checks", async () => {
    f.model.mockResolvedValue(response({ confidence: .6 })); expect((await resolveStudioConversationModel(input(), undefined, AbortSignal.timeout(1000))).action).toBe("clarify");
    f.model.mockResolvedValue(response()); const result = await resolveStudioConversationModel(input({ text: "修改图片2 1080×1920 比例1:1" }), undefined, AbortSignal.timeout(1000));
    expect(result.action).toBe("clarify"); expect(result.clarification).toContain("不一致");
  });
  it("marks unknown response as no-generation clarification, never a rules guess", () => {
    const result = unknownStudioConversationIntent(input()); expect(result.action).toBe("clarify"); expect(result.modelStatus).toBe("UNKNOWN"); expect(result.targetReferenceId).toBeNull();
  });
  it("lets the model resolve context instead of applying a second semantic regex veto", async () => {
    const current = input({ text: "继续修改上一张的背景" });
    expect((await resolveStudioConversationModel(current, undefined, AbortSignal.timeout(1000))).targetReferenceId).toBe(two.referenceId);
    expect((await resolveStudioConversationModel(current, current.references[0], AbortSignal.timeout(1000))).targetReferenceId).toBe(two.referenceId);
    const named = input({ text: "继续修改图片2的背景" });
    expect((await resolveStudioConversationModel(named, undefined, AbortSignal.timeout(1000))).targetReferenceId).toBe(two.referenceId);
  });
  it("rejects extra fields, retry policies and malformed decision shape", () => {
    const req = { schemaVersion: 1, text: "poster", references: [], quickEditTargetId: null, previousResultReferenceId: null };
    expect(StudioConversationModelRequest.parse(req).providerRetryPolicy).toBe("never");
    expect(StudioConversationModelRequest.safeParse({ ...req, providerRetryPolicy: "auto" }).success).toBe(false);
    for (const decision of [{ action: "generate", targetReferenceId: "invented" }, { confidence: 1.1 }, { provider: "mock" }, { action: "clarify", clarification: null }]) expect(StudioConversationModelResponse.safeParse(response(decision)).success).toBe(false);
  });
});

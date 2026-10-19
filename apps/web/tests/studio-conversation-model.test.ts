import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioConversationInput } from "../../../packages/contracts/src/studio-conversation";
import { StudioConversationModelRequest, StudioConversationModelResponse } from "../../../packages/contracts/src/studio-conversation-model";
const f = vi.hoisted(() => ({ settings: vi.fn(), model: vi.fn() }));
vi.mock("../src/lib/settings", () => ({ getEffectiveAiSettings: f.settings }));
vi.mock("../src/lib/ai", () => ({ ai: { studioConversationIntent: f.model } }));
vi.mock("../src/lib/ai-service", () => ({ resolveAiService: vi.fn(async () => ({ studioConversationIntentRevision: "structured-conversation-intent-r1" })) }));
import { studioConversationModelAvailable, resolveStudioConversationModel, unknownStudioConversationIntent } from "../src/lib/studio-conversation-model";
const ref = { referenceId: "shape:one", shapeId: "shape:one", name: "图片1", assetId: "a1", assetSha256: "a".repeat(64), width: 1080, height: 1920 };
const two = { ...ref, referenceId: "shape:two", shapeId: "shape:two", name: "图片2", assetId: "a2" };
const input = (extra = {}) => StudioConversationInput.parse({ mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", text: "调整图片2，参考图片1，1080×1920", documentRevision: 1,
  workflowRevision: 0, references: [ref, two], sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" }, ...extra });
const response = (decision = {}) => ({ revision: "structured-conversation-intent-r1", decision: { action: "modify", targetReferenceId: two.referenceId, referenceIds: [ref.referenceId], confidence: .95, clarification: null, ...decision } });
beforeEach(() => { vi.resetAllMocks(); delete process.env.STUDIO_CONVERSATION_INTENT_ENABLED; f.model.mockResolvedValue(response()); f.settings.mockResolvedValue({ vlm: { provider: "openai", apiKey: "fixture-unit-only" } }); });
describe("formal structured model adapter without any real provider calls", () => {
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
  it("passes labels/IDs only and keeps width-height resolution server authoritative", async () => {
    const result = await resolveStudioConversationModel(input(), undefined, AbortSignal.timeout(1000));
    expect(result.parser).toBe("structured-model-v1"); expect(result.modelStatus).toBe("SUCCEEDED"); expect(result.targetReferenceId).toBe(two.referenceId);
    expect(result.requestedSize).toEqual({ width: 1080, height: 1920 }); expect(result.referenceIds).toEqual([ref.referenceId]);
    expect(f.model).toHaveBeenCalledOnce(); const [request, options] = f.model.mock.calls[0]!; expect(request.providerRetryPolicy).toBe("never");
    expect(request.references[0]).toEqual({ referenceId: ref.referenceId, name: ref.name, editable: true }); expect(options.maxResponseBytes).toBe(16384);
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
  it("cannot invent or substitute the unique previous result for continue-last", async () => {
    const current = input({ text: "继续修改上一张的背景" });
    expect((await resolveStudioConversationModel(current, undefined, AbortSignal.timeout(1000))).action).toBe("clarify");
    expect((await resolveStudioConversationModel(current, current.references[0], AbortSignal.timeout(1000))).action).toBe("clarify");
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

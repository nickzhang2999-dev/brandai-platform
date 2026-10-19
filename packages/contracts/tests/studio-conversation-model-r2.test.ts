import { describe, expect, it } from "vitest";
import { StudioConversationModelRequest, StudioConversationModelResponse, StudioConversationThumbnail } from "../src/studio-conversation-model";
import { StudioConversationInput, StudioConversationIntent, StudioConversationMessage } from "../src/studio-conversation";

const thumbnail = { dataUrl: "data:image/png;base64,YQ==", width: 8, height: 6 };
const references = [{ referenceId: "one", name: "图片1", editable: false, thumbnail }, { referenceId: "two", name: "图片2", editable: true }];
const request = { schemaVersion: 2, text: "保留文案夏日，换蓝背景", references, quickEditTargetId: null, previousResultReferenceId: "two", history: [{ role: "assistant", text: "上一张已完成", resultReferenceId: "two" }], selectedReferenceIds: ["two"] };
const action = { action: "modify", targetReferenceId: "two", referenceIds: ["one"], confidence: .9, clarification: null, imagePrompt: "将图片2背景改蓝，保留夏日文案", options: [] };
const option = { id: "edit", label: "修改图片2", action: "modify", targetReferenceId: "two", referenceIds: ["one"], imagePrompt: "将图片2背景改蓝，保留夏日文案" };
const reference = { referenceId: "two", shapeId: "shape:image2", name: "图片2", assetId: "asset2", assetSha256: "a".repeat(64), width: 1024, height: 1024 };
const input = { mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", text: "换蓝背景", references: [reference], quickEditTargetId: "two", sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" }, documentRevision: 1, workflowRevision: 0, psdLayerMode: "MANUAL", psdLayerCount: 3 };

describe("r2 bounded multimodal planner contract", () => {
  it("keeps legacy r1 request/response shapes readable", () => {
    const { history: _, selectedReferenceIds: __, ...oldRequest } = request;
    expect(StudioConversationModelRequest.parse({ ...oldRequest, schemaVersion: 1, references: references.map(({ referenceId, name, editable }) => ({ referenceId, name, editable })) }).schemaVersion).toBe(1);
    const { imagePrompt: ___, options: ____, ...oldDecision } = action;
    expect(StudioConversationModelResponse.parse({ revision: "structured-conversation-intent-r1", decision: oldDecision }).revision).toBe("structured-conversation-intent-r1");
    expect(StudioConversationModelResponse.safeParse({ revision: "structured-conversation-intent-r1", decision: action }).success).toBe(false);
  });

  it("accepts visual-only previous result and rejects a fifth thumbnail", () => {
    const lastResultImage = { name: "上一张结果", thumbnail };
    expect(StudioConversationModelRequest.safeParse({ ...request, lastResultImage }).success).toBe(true);
    expect(StudioConversationModelRequest.safeParse({ ...request, lastResultImage: { ...lastResultImage, referenceId: "invented" } }).success).toBe(false);
    expect(StudioConversationModelRequest.safeParse({ ...request, references: Array.from({ length: 4 }, (_, i) => ({ referenceId: `ref${i}`, name: `图片${i}`, editable: true, thumbnail })), history: [], previousResultReferenceId: null, selectedReferenceIds: [], lastResultImage }).success).toBe(false);
  });

  it.each([{ selectedReferenceIds: ["foreign"] }, { selectedReferenceIds: ["two", "two"] }, { history: [{ role: "assistant", text: "result", resultReferenceId: "foreign" }] }, { quickEditTargetId: "one" }, { lastResultImage: null }, { history: undefined }])("rejects invalid frozen context %j", change => {
    expect(StudioConversationModelRequest.safeParse({ ...request, ...change }).success).toBe(false);
  });

  it("bounds inline bytes and pixel metadata; never accepts a remote URL", () => {
    expect(StudioConversationThumbnail.safeParse(thumbnail).success).toBe(true);
    for (const change of [{ width: 513 }, { dataUrl: "https://private.invalid/image" }, { dataUrl: "data:image/png;base64," }, { dataUrl: "data:image/png;base64," + "YWFh".repeat(43691) }]) {
      expect(StudioConversationThumbnail.safeParse({ ...thumbnail, ...change }).success).toBe(false);
    }
  });

  it("requires rewritten prompts and two or three distinct actionable clarification choices", () => {
    const response = (decision: unknown) => StudioConversationModelResponse.safeParse({ revision: "structured-conversation-intent-r2", decision });
    expect(response(action).success).toBe(true);
    expect(response({ ...action, imagePrompt: null }).success).toBe(false);
    expect(response({ ...action, options: [option] }).success).toBe(false);
    const clarify = { ...action, action: "clarify", targetReferenceId: null, imagePrompt: null, clarification: "选择用途", options: [option, { ...option, id: "new", action: "generate", targetReferenceId: null }] };
    expect(response(clarify).success).toBe(true);
    expect(response({ ...clarify, options: [option] }).success).toBe(false);
    expect(response({ ...clarify, options: [option, option] }).success).toBe(false);
    expect(response({ ...clarify, options: [{ ...option, referenceIds: ["two"] }, { ...option, id: "other" }] }).success).toBe(false);
  });

  it("keeps absent usage distinct from zero and does not accept arbitrary telemetry", () => {
    const response = { revision: "structured-conversation-intent-r2", decision: action };
    expect(StudioConversationModelResponse.safeParse(response).success).toBe(true);
    expect(StudioConversationModelResponse.safeParse({ ...response, usage: { latencyMs: 8, inputTokens: 0 } }).success).toBe(true);
    for (const usage of [null, { latencyMs: 1, inputTokens: null }, { latencyMs: 1, inputTokens: "8" }, { latencyMs: 1, prompt: "private" }]) {
      expect(StudioConversationModelResponse.safeParse({ ...response, usage }).success).toBe(false);
    }
  });
});

describe("public choice contract retains exact original input", () => {
  it("accepts identifier-only choice and selection while preserving PSD/size fields", () => {
    const value = StudioConversationInput.parse({ ...input, selectedReferenceIds: ["two"], decision: { sourceMessageId: "message1", optionId: "edit", kind: "clarification" } });
    expect(value.psdLayerCount).toBe(3);
    expect(value.decision?.sourceMessageId).toBe("message1");
    expect(StudioConversationInput.safeParse({ ...value, decision: { ...value.decision, imagePrompt: "client override" } }).success).toBe(false);
    expect(StudioConversationInput.safeParse({ ...value, selectedReferenceIds: ["foreign"] }).success).toBe(false);
  });

  it("reads old intents and exposes original input but no server-only thumbnail context", () => {
    const intent = { action: "modify", targetReferenceId: "two", referenceIds: [], prompt: input.text, clarification: null, requestedSize: null, sizeSource: "target", sizeSelection: input.sizeSelection, parser: "structured-model-v1" };
    expect(StudioConversationIntent.safeParse(intent).success).toBe(true);
    const message = { messageId: "msg1", mutationId: input.mutationId, projectId: "project1", text: input.text, references: input.references, status: "SUCCEEDED", intent, generation: null, error: null, clarification: null, createdAt: "2026-10-19T00:00:00.000Z", expiresAt: "2026-10-19T00:06:00.000Z", originalInput: input };
    expect(StudioConversationMessage.parse(message).originalInput?.psdLayerCount).toBe(3);
    expect(StudioConversationMessage.safeParse({ ...message, originalInput: { ...input, history: [] } }).success).toBe(false);
  });
});

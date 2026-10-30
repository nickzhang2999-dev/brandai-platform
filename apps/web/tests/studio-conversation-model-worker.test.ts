import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioConversationInput } from "../../../packages/contracts/src/studio-conversation";
import { parseStudioConversationIntent } from "../src/lib/studio-conversation-intent";
import { studioConversationFeedback } from "../src/lib/studio-conversation-feedback";
const f = vi.hoisted(() => ({ db: {} as any, row: null as any, available: vi.fn(), resolve: vi.fn(), context: vi.fn(), submit: vi.fn(), validate: vi.fn(), gate: vi.fn(), recover: vi.fn(), trusted: vi.fn() }));
vi.mock("@/lib/studio-brand-materials", () => ({ requireTrustedStudioBrandProjectMaterial: f.trusted }));
vi.mock("@/lib/studio-conversation-context", () => ({ loadStudioConversationContext: f.context }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: f.db, Prisma: { DbNull: "DbNull" } }));
vi.mock("@/lib/queue", () => ({ connection: {}, queuePrefix: "test" }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/lib/studio-generation", () => ({ submitStudioGeneration: f.submit }));
vi.mock("@/lib/studio-generation-artifacts", () => ({ requireArtifactWrite: f.gate }));
vi.mock("@/lib/studio-conversation", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/studio-conversation")>("../src/lib/studio-conversation");
  return { validateConversationReferences: f.validate, conversationGenerationInput: actual.conversationGenerationInput,
    conversationGenerationAcceptance: actual.conversationGenerationAcceptance, recoverStudioConversationGeneration: f.recover };
});
vi.mock("@/lib/studio-conversation-queue", () => ({ enqueueStudioConversation: vi.fn() }));
vi.mock("@/lib/studio-conversation-model", () => ({ studioConversationModelAvailable: f.available, resolveStudioConversationModel: f.resolve,
  unknownStudioConversationIntent: (input: any) => ({ ...parseStudioConversationIntent(input), action: "clarify", targetReferenceId: null, clarification: "Unknown model result", parser: "structured-model-v1", modelStatus: "UNKNOWN" }) }));
import { runStudioConversationJob } from "../src/lib/workers/studio-conversation.worker";
import { ApiException } from "@/lib/api";
const input = StudioConversationInput.parse({ mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", text: "生成一张海报", references: [], documentRevision: 0, workflowRevision: 0,
  sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" } });
beforeEach(() => {
  vi.clearAllMocks(); delete process.env.STUDIO_CONVERSATION_INTENT_ENABLED;
  f.trusted.mockReset();
  f.recover.mockImplementation(async row => row);
  f.context.mockResolvedValue({ references: [], history: [], selectedReferenceIds: [] });
  f.row = { id: "m", conversationId: "c", input, references: [], intent: null, intentModelStartedAt: null, acceptedCanvas: "", status: "PENDING",
    generationRequestId: null, startedAt: null, attemptToken: null, expiresAt: new Date(Date.now() + 300000), createdAt: new Date(), conversation: { workspaceId: "w", projectId: "p", userId: "u" } };
  f.available.mockResolvedValue(true); f.resolve.mockResolvedValue({ ...parseStudioConversationIntent(input), parser: "structured-model-v1", modelStatus: "SUCCEEDED" }); f.submit.mockResolvedValue({ requestId: "generation-original" });
  Object.assign(f.db, { $transaction: async (fn: any) => fn(f.db), $queryRaw: async () => [{ id: "m" }], user: { findUnique: async () => ({ isActive: true }) },
    studioGeneratedMaterial: { findMany: async () => [] },
    studioConversationMessage: { findUnique: async () => structuredClone(f.row), findMany: async () => [], update: async ({data}: any) => Object.assign(f.row,data),
      updateMany: vi.fn(async ({where,data}: any) => { if (where.intentModelStartedAt === null && f.row.intentModelStartedAt !== null
        || where.attemptToken && where.attemptToken !== f.row.attemptToken || typeof where.status === "string" && where.status !== f.row.status
        || where.expiresAt?.gt && f.row.expiresAt <= where.expiresAt.gt) return {count:0}; Object.assign(f.row,data); return {count:1}; }) } });
});
describe("durable structured intent claim, no real model or image calls", () => {
  it.each([false, true])("consumes an explicitly frozen project context, rejects its revoked source before any model; revoked=%s", async revoked => {
    const projectContext = { projectId: "p", revision: 1, facts: { goal: "广告海报", audience: "学生", approvedCopy: "一起出发", visualRequirements: "绿色" },
      materials: [], master: { assetId: "master", assetSha256: "a".repeat(64), shapeId: "shape:master", versionId: "v1", name: "确认主稿", width: 1024, height: 1024 }, updatedAt: null };
    f.row.projectContextJson = projectContext; f.row.input = StudioConversationInput.parse({ ...input, projectContextRevision: 1 });
    if (revoked) f.trusted.mockRejectedValue(new ApiException(404, "Source removed"));
    else f.trusted.mockResolvedValue({ generationVersionId: "v1", width: 1024, height: 1024 });
    f.resolve.mockImplementation(async (effective: any) => ({ ...parseStudioConversationIntent(effective), parser: "structured-model-v2", modelStatus: "SUCCEEDED" }));
    await runStudioConversationJob({ data: { messageId: "m" } } as any);
    if (revoked) { expect(f.resolve).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.row.status).toBe("FAILED"); }
    else {
      expect(f.resolve.mock.calls[0][0].references).toMatchObject([{ assetId: "master", purpose: "REFERENCE" }]);
      expect(f.resolve.mock.calls[0][0].references[0]).not.toHaveProperty("shapeId");
      expect(f.resolve.mock.calls[0][3].projectContext).toMatchObject({ facts: projectContext.facts, masterReferenceId: "project-context:master" });
      expect(f.submit.mock.calls[0][2].prompt).toContain("一起出发");
      expect(f.submit.mock.calls[0][3].projectContext).toEqual(projectContext);
      expect(f.row.input.references).toEqual([]); expect(f.row.input.text).toBe(input.text); expect(f.trusted).toHaveBeenCalledTimes(2);
    }
  });
  it.each(["先别生成一张海报", "不要修改背景", "这张怎么样？", "背景很好看", "这是参考图"])
  ("does not charge either semantic or image models for commentary/holds: %s", async text => {
    const ref = { referenceId: "shape:one", shapeId: "shape:one", assetId: "a1", assetSha256: "a".repeat(64), name: "图片1", width: 1024, height: 1024 };
    f.row.input = StudioConversationInput.parse({ ...input, text, references: [ref], quickEditTargetId: ref.referenceId });
    await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.available).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    expect(f.row.status).toBe("CLARIFICATION"); expect(f.row.intent.targetReferenceId).toBeNull();
  });
  it("does not execute a legacy saved chargeable intent for a hold", async () => {
    f.row.input = StudioConversationInput.parse({ ...input, text: "先别生成一张海报" });
    f.row.intent = parseStudioConversationIntent(input);
    await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.recover).toHaveBeenCalledOnce();
    expect(f.available).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    expect(f.row.status).toBe("CLARIFICATION");
  });
  it("generates a reference scene brief when no semantic model is configured", async () => {
    const ref = { referenceId: "shape:one", shapeId: "shape:one", assetId: "a1", assetSha256: "a".repeat(64), name: "图片1", width: 1024, height: 1024 };
    f.available.mockResolvedValue(false);
    f.row.input = StudioConversationInput.parse({ ...input, text: "根据这张图，我需要小狐狸在家里开门给小白鼠糖", references: [ref] });
    await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.submit).toHaveBeenCalledOnce();
    expect(f.row.intent.action).toBe("generate"); expect(f.row.intent.referenceIds).toEqual([ref.referenceId]);
  });
  it("rewrites an explicitly selected target with the model while preserving the pin", async () => {
    const ref = { referenceId: "shape:one", shapeId: "shape:one", assetId: "a1", assetSha256: "a".repeat(64), name: "图片1", width: 1024, height: 1024 };
    f.row.input = StudioConversationInput.parse({ ...input, text: "光影自然一点，阳光洒下", references: [ref], quickEditTargetId: ref.referenceId });
    f.resolve.mockResolvedValue({ ...parseStudioConversationIntent(f.row.input), parser: "structured-model-v2", modelStatus: "SUCCEEDED", imagePrompt: "保留构图，光影自然，阳光洒下" });
    await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.validate).toHaveBeenCalledOnce(); expect(f.gate).toHaveBeenCalledOnce();
    expect(f.available).toHaveBeenCalledOnce(); expect(f.resolve).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledOnce(); expect(f.row.intent.targetReferenceId).toBe(ref.referenceId);
    expect(f.row.intent.action).toBe("modify"); expect(f.row.intentModelStartedAt).toBeInstanceOf(Date);
  });
  it("does not bypass a previously uncertain intent call even with a pinned target", async () => {
    const ref = { referenceId: "shape:one", shapeId: "shape:one", assetId: "a1", assetSha256: "a".repeat(64), name: "图片1", width: 1024, height: 1024 };
    f.row.input = StudioConversationInput.parse({ ...input, text: "光影自然一点", references: [ref], quickEditTargetId: ref.referenceId });
    f.row.intentModelStartedAt = new Date();
    await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.available).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    expect(f.row.status).toBe("CLARIFICATION"); expect(f.row.intent.modelStatus).toBe("UNKNOWN");
  });
  it.each([
    "修改目标已失效、归属不符或原始配方发生变化，请重新选择图片。",
    "这张历史生成图片缺少可验证的原始合成记录，暂不能继续改图。请选用新工作台生成的图片。",
    "修改目标在准备期间无法通过来源校验，未调用生成服务。请重新选择图片后提交。",
  ].flatMap(notice => ["fresh", "saved-intent", "unknown-intent"].map(state => [notice, state])))
  ("does not call any model for an echoed system error (%s, %s)", async (notice, state) => {
    const ref = { referenceId: "shape:one", shapeId: "shape:one", assetId: "a1", assetSha256: "a".repeat(64), name: "图片1", width: 1024, height: 1024 };
    f.row.input = StudioConversationInput.parse({ ...input, text: notice, references: [ref], quickEditTargetId: ref.referenceId });
    if (state === "saved-intent") f.row.intent = { ...parseStudioConversationIntent(input), action: "modify", targetReferenceId: ref.referenceId, prompt: notice };
    if (state === "unknown-intent") f.row.intentModelStartedAt = new Date();
    await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.available).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    expect(f.row.status).toBe("CLARIFICATION"); expect(f.row.intent.targetReferenceId).toBeNull();
    expect(f.row.intent.clarification).toContain("不会据此发起新的模型调用"); expect(f.row.generationRequestId).toBeNull();
  });
  it("recovers an already accepted legacy request before classifying its notice as feedback", async () => {
    const notice = "修改目标已失效、归属不符或原始配方发生变化，请重新选择图片。";
    f.row.input = StudioConversationInput.parse({ ...input, text: notice });
    const acceptedIntent = { ...parseStudioConversationIntent(input), prompt: notice };
    f.row.intent = acceptedIntent;
    f.recover.mockImplementation(async row => {
      expect(row.intent).toEqual(acceptedIntent);
      Object.assign(f.row, { generationRequestId: "existing-accepted-generation", attemptToken: null });
      return { ...row, generationRequestId: "existing-accepted-generation" };
    });
    await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.recover).toHaveBeenCalledOnce(); expect(f.row.intent).toEqual(acceptedIntent);
    expect(f.row.status).toBe("RUNNING"); expect(f.row.generationRequestId).toBe("existing-accepted-generation");
    expect(f.available).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });
  it("stamps the durable model claim before the one model call and reuses generation intake", async () => {
    f.resolve.mockImplementation(async () => { expect(f.row.intentModelStartedAt).toBeInstanceOf(Date); return { ...parseStudioConversationIntent(input), parser: "structured-model-v1", modelStatus: "SUCCEEDED" }; });
    await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.resolve).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce(); expect(f.row.generationRequestId).toBe("generation-original");
  });
  it("never reissues a started-but-unconfirmed model request after a worker restart", async () => {
    f.row.intentModelStartedAt = new Date(); await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.row.status).toBe("CLARIFICATION"); expect(f.row.intent.modelStatus).toBe("UNKNOWN");
  });
  it("keeps a previously persisted intent byte-for-byte stable for lost generation acknowledgement recovery", async () => {
    f.row.intent = parseStudioConversationIntent(input);
    const original = structuredClone(f.row.intent);
    await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.row.intent).toEqual(original); expect(f.row.intent).not.toHaveProperty("options");
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.submit.mock.calls[0]![3].intent).toEqual(original);
  });
  it("turns timeout into clarification without falling back into an image charge", async () => {
    f.resolve.mockRejectedValue(new Error("provider result unknown")); await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.resolve).toHaveBeenCalledOnce(); expect(f.submit).not.toHaveBeenCalled(); expect(f.row.status).toBe("CLARIFICATION");
  });
  it("fails thumbnail preparation before the durable paid-model claim", async () => {
    f.context.mockRejectedValueOnce(new Error("source unavailable"));
    await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.row.intentModelStartedAt).toBeNull(); expect(f.row.status).toBe("FAILED");
  });
  it("does not create an image generation after losing its attempt during model execution", async () => {
    f.resolve.mockImplementation(async () => { f.row.attemptToken = "different-attempt"; return { ...parseStudioConversationIntent(input), parser: "structured-model-v1", modelStatus: "SUCCEEDED" }; });
    await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.submit).not.toHaveBeenCalled(); expect(f.row.intent).toBeNull();
  });
  it("does not publish intent or create generation after its authoritative expiry", async () => {
    f.resolve.mockImplementation(async () => { f.row.expiresAt = new Date(Date.now() - 1000); return { ...parseStudioConversationIntent(input), parser: "structured-model-v1", modelStatus: "SUCCEEDED" }; });
    await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.submit).not.toHaveBeenCalled(); expect(f.row.intent).toBeNull();
  });
  it("marks enabled-but-unconfigured fallback explicitly and does not invoke the model", async () => {
    process.env.STUDIO_CONVERSATION_INTENT_ENABLED = "1"; f.available.mockResolvedValue(false);
    await runStudioConversationJob({ data: { messageId: "m" } } as any); expect(f.resolve).not.toHaveBeenCalled(); expect(f.row.intent.modelStatus).toBe("UNAVAILABLE");
    delete process.env.STUDIO_CONVERSATION_INTENT_ENABLED;
  });
});

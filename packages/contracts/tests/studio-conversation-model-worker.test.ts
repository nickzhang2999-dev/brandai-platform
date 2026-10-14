import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioConversationInput } from "../src/studio-conversation";
import { parseStudioConversationIntent } from "../../../apps/web/src/lib/studio-conversation-intent";
const f = vi.hoisted(() => ({ db: {} as any, row: null as any, available: vi.fn(), resolve: vi.fn(), submit: vi.fn(), validate: vi.fn(), gate: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: f.db, Prisma: { DbNull: "DbNull" } }));
vi.mock("@/lib/queue", () => ({ connection: {}, queuePrefix: "test" }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/lib/studio-generation", () => ({ submitStudioGeneration: f.submit }));
vi.mock("@/lib/studio-generation-artifacts", () => ({ requireArtifactWrite: f.gate }));
vi.mock("@/lib/studio-conversation", () => ({ validateConversationReferences: f.validate,
  conversationGenerationInput: (projectId: string, input: any, intent: any) => ({ projectId, mutationId: input.mutationId, prompt: intent.prompt }), recoverStudioConversationGeneration: vi.fn() }));
vi.mock("@/lib/studio-conversation-queue", () => ({ enqueueStudioConversation: vi.fn() }));
vi.mock("@/lib/studio-conversation-intent", () => ({ parseStudioConversationIntent }));
vi.mock("@/lib/studio-conversation-model", () => ({ studioConversationModelAvailable: f.available, resolveStudioConversationModel: f.resolve,
  unknownStudioConversationIntent: (input: any) => ({ ...parseStudioConversationIntent(input), action: "clarify", targetReferenceId: null, clarification: "Unknown model result", parser: "structured-model-v1", modelStatus: "UNKNOWN" }) }));
import { runStudioConversationJob } from "../../../apps/web/src/lib/workers/studio-conversation.worker";
const input = StudioConversationInput.parse({ mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", text: "生成一张海报", references: [], documentRevision: 0, workflowRevision: 0,
  sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" } });
beforeEach(() => {
  vi.clearAllMocks(); delete process.env.STUDIO_CONVERSATION_INTENT_ENABLED;
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
  it("stamps the durable model claim before the one model call and reuses generation intake", async () => {
    f.resolve.mockImplementation(async () => { expect(f.row.intentModelStartedAt).toBeInstanceOf(Date); return { ...parseStudioConversationIntent(input), parser: "structured-model-v1", modelStatus: "SUCCEEDED" }; });
    await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.resolve).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce(); expect(f.row.generationRequestId).toBe("generation-original");
  });
  it("never reissues a started-but-unconfirmed model request after a worker restart", async () => {
    f.row.intentModelStartedAt = new Date(); await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.row.status).toBe("CLARIFICATION"); expect(f.row.intent.modelStatus).toBe("UNKNOWN");
  });
  it("turns timeout into clarification without falling back into an image charge", async () => {
    f.resolve.mockRejectedValue(new Error("provider result unknown")); await runStudioConversationJob({ data: { messageId: "m" } } as any);
    expect(f.resolve).toHaveBeenCalledOnce(); expect(f.submit).not.toHaveBeenCalled(); expect(f.row.status).toBe("CLARIFICATION");
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

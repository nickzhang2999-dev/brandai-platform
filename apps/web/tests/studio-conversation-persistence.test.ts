import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ db: {} as any, auth: vi.fn(), gate: vi.fn(), materials: vi.fn(), assets: vi.fn(), enqueue: vi.fn(), generation: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: f.db, Prisma: { PrismaClientKnownRequestError: class extends Error {}, TransactionIsolationLevel: { Serializable: "Serializable" } } }));
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../src/lib/studio-materials", () => ({ requireStudioMaterialProject: f.auth }));
vi.mock("../src/lib/studio-generation-artifacts", () => ({ requireArtifactWrite: f.gate }));
vi.mock("../src/lib/studio-generation-policy", () => ({ hashStudioPayload: (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex") }));
vi.mock("../src/lib/studio-project-materials", () => ({ listStudioProjectMaterials: f.materials }));
vi.mock("../src/lib/studio-workflow-codec", () => ({ workflowAssets: () => ({ assets: f.assets() }) }));
vi.mock("../src/lib/studio-generation", () => ({ readStudioGeneration: f.generation }));
vi.mock("../src/lib/studio-conversation-queue", () => ({ enqueueStudioConversation: f.enqueue }));
vi.mock("../src/lib/studio-conversation-snapshot", () => ({ freezeStudioConversationCanvas: (canvas: string) => canvas }));
import { submitStudioConversation, readStudioConversation, saveStudioConversationDraft, recoverStudioConversationGeneration, conversationGenerationInput } from "../src/lib/studio-conversation";
import { StudioConversationInput } from "../../../packages/contracts/src/studio-conversation";
import { parseStudioConversationIntent } from "../src/lib/studio-conversation-intent";

let conversation: any, messages: any[], canvas: string;
const base = { mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", text: "生成一张海报", references: [], documentRevision: 1, workflowRevision: 0,
  sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" } };
const reference = { referenceId: "shape:image", shapeId: "shape:image", name: "图片1", assetId: "a", assetSha256: "a".repeat(64), width: 1024, height: 1024 };
beforeEach(() => {
  vi.clearAllMocks(); conversation = null; messages = []; canvas = "server frozen canvas";
  f.assets.mockReturnValue([{ shapeId: reference.shapeId, assetSha256: reference.assetSha256, valid: true }]);
  f.materials.mockResolvedValue([{ assetId: "a", sha256: reference.assetSha256, width: 1024, height: 1024 }]);
  f.enqueue.mockResolvedValue(false);
  Object.assign(f.db, {
    $transaction: async (fn: any) => fn(f.db),
    editorDocument: { findUnique: async () => ({ workspaceId: "w", revision: 1, canvas }) },
    workbenchProjectState: { findUnique: async () => ({ workspaceId: "w", workflowRevision: 0 }) },
    asset: { count: async ({ where }: any) => where.workspaceId === "w" ? where.id.in.length : 0, findFirst: async () => null },
    studioConversation: {
      upsert: async ({ create }: any) => conversation ??= { ...create, id: "conversation", draft: null, draftRevision: 0 },
      findUnique: async ({ where }: any) => conversation && Object.entries(where.workspaceId_userId_projectId).every(([key, value]) => conversation[key] === value) ? conversation : null,
      updateMany: async ({ where, data }: any) => { if (!conversation || conversation.id !== where.id || conversation.draftRevision !== where.draftRevision) return { count: 0 }; conversation.draft = data.draft; conversation.draftRevision++; return { count: 1 }; },
    },
    studioConversationMessage: {
      findUnique: async ({ where }: any) => messages.find(row => row.conversationId === where.conversationId_mutationId.conversationId && row.mutationId === where.conversationId_mutationId.mutationId) ?? null,
      findFirst: async ({ where }: any) => messages.find(row => row.id === where.id && row.conversationId === where.conversationId) ?? null,
      count: async () => messages.length,
      create: async ({ data }: any) => { const row = { ...data, conversation, intent: null, generationRequestId: null, status: "PENDING", error: null, createdAt: new Date() }; messages.push(row); return row; },
      findMany: async () => messages.slice().reverse(),
      updateMany: async ({ where, data }: any) => { const row = messages.find(value => value.id === where.id); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
    },
  });
});
describe("durable conversation intake and isolated drafts (DB adapter interaction tests)", () => {
  it("persists a pending outbox and immutable refs/canvas before queue delivery", async () => {
    const reply = await submitStudioConversation("w", "u", "p", { ...base, references: [reference] });
    expect(reply.status).toBe("PENDING"); expect(messages[0].acceptedCanvas).toBe(canvas);
    expect(f.enqueue).toHaveBeenCalledWith(reply.messageId); expect(f.auth).toHaveBeenCalledWith("w", "u", "p", true);
    canvas = "later canvas"; expect(messages[0].acceptedCanvas).toBe("server frozen canvas");
    expect(f.generation).not.toHaveBeenCalled();
  });
  it("replays identical lost responses and rejects a changed mutation payload", async () => {
    const first = await submitStudioConversation("w", "u", "p", base);
    const replay = await submitStudioConversation("w", "u", "p", base);
    expect(replay.messageId).toBe(first.messageId); expect(messages).toHaveLength(1);
    await expect(submitStudioConversation("w", "u", "p", { ...base, text: "different" })).rejects.toMatchObject({ status: 409 });
    expect(messages).toHaveLength(1);
  });
  it("rejects stale revision, cross-tenant bytes, hidden targets and wrong metadata", async () => {
    await expect(submitStudioConversation("w", "u", "p", { ...base, documentRevision: 0 })).rejects.toMatchObject({ status: 409 });
    await expect(submitStudioConversation("w", "u", "p", { ...base, references: [{ ...reference, assetId: "foreign" }] })).rejects.toMatchObject({ status: 422 });
    await expect(submitStudioConversation("w", "u", "p", { ...base, references: [{ ...reference, width: 500 }] })).rejects.toMatchObject({ status: 422 });
    f.assets.mockReturnValue([{ shapeId: reference.shapeId, assetSha256: reference.assetSha256, valid: false }]);
    await expect(submitStudioConversation("w", "u", "p", { ...base, references: [reference] })).rejects.toMatchObject({ status: 409 });
    expect(messages).toHaveLength(0); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("restores message history and refuses another user's message/cursor", async () => {
    const receipt = await submitStudioConversation("w", "u", "p", base);
    const history: any = await readStudioConversation("w", "u", "p", {}); expect(history.messages[0].messageId).toBe(receipt.messageId);
    await expect(readStudioConversation("w", "other", "p", { messageId: receipt.messageId })).rejects.toMatchObject({ status: 404 });
    await expect(readStudioConversation("w", "u", "p", { before: "foreign" })).rejects.toMatchObject({ status: 404 });
  });
  it("starts a new project's chat input with the home brief, once and within limits", async () => {
    f.db.workbenchProjectState.findUnique = async () => ({ workspaceId: "w", workflowRevision: 0, brief: "  夏季新品海报，蓝紫渐变  " });
    const fresh: any = await readStudioConversation("w", "u", "p", {});
    expect(fresh.draft).toMatchObject({ text: "夏季新品海报，蓝紫渐变", references: [], revision: 0 });
    // The prefilled draft saves through the normal revision path, then wins over the brief.
    await saveStudioConversationDraft("w", "u", "p", { ...fresh.draft, text: "改成橙色" });
    expect(((await readStudioConversation("w", "u", "p", {})) as any).draft.text).toBe("改成橙色");
    conversation = null;
    f.db.workbenchProjectState.findUnique = async () => ({ workspaceId: "w", workflowRevision: 0, brief: "长".repeat(5000) });
    expect(((await readStudioConversation("w", "u", "p", {})) as any).draft.text).toHaveLength(4000);
    f.db.workbenchProjectState.findUnique = async () => ({ workspaceId: "other", workflowRevision: 0, brief: "别家品牌需求" });
    expect(((await readStudioConversation("w", "u", "p", {})) as any).draft).toBeNull();
    f.db.workbenchProjectState.findUnique = async () => ({ workspaceId: "w", workflowRevision: 0, brief: "   " });
    expect(((await readStudioConversation("w", "u", "p", {})) as any).draft).toBeNull();
  });
  it("persists ordered draft refs and protects newer drafts across tabs", async () => {
    const draft = { revision: 0, text: "unfinished", references: [reference], quickEditTargetId: reference.referenceId, sizeSelection: base.sizeSelection };
    const saved = await saveStudioConversationDraft("w", "u", "p", draft); expect(saved.revision).toBe(1);
    expect((await saveStudioConversationDraft("w", "u", "p", draft)).revision).toBe(1);
    await expect(saveStudioConversationDraft("w", "u", "p", { ...draft, text: "changed", revision: 0 })).rejects.toMatchObject({ status: 409 });
    const history: any = await readStudioConversation("w", "u", "p", {}); expect(history.draft.text).toBe("unfinished"); expect(history.draft.quickEditTargetId).toBe(reference.referenceId);
  });
  it("recovers an accepted generation after an unknown acknowledgement without enqueueing again", async () => {
    await submitStudioConversation("w", "u", "p", base);
    const row = messages[0], input = StudioConversationInput.parse(row.input), intent = parseStudioConversationIntent(input); row.intent = intent;
    const expected = createHash("sha256").update(JSON.stringify({ input: conversationGenerationInput("p", input, intent), accepted: { canvas: row.acceptedCanvas, references: input.references, intent } })).digest("hex");
    f.db.studioGenerationRequest = { findUnique: vi.fn().mockResolvedValue({ id: "original-generation", payloadHash: expected }) };
    f.enqueue.mockClear();
    const recovered = await recoverStudioConversationGeneration(row); expect(recovered.generationRequestId).toBe("original-generation"); expect(recovered.status).toBe("RUNNING");
    expect(f.enqueue).not.toHaveBeenCalled(); expect(f.db.studioGenerationRequest.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId_userId_projectId_mutationId: { workspaceId: "w", userId: "u", projectId: "p", mutationId: base.mutationId } } }));
  });
  it("does not attach a different payload merely because the UUID matches", async () => {
    await submitStudioConversation("w", "u", "p", base); messages[0].intent = parseStudioConversationIntent(StudioConversationInput.parse(messages[0].input));
    f.db.studioGenerationRequest = { findUnique: vi.fn().mockResolvedValue({ id: "different-generation", payloadHash: "f".repeat(64) }) };
    expect((await recoverStudioConversationGeneration(messages[0])).generationRequestId).toBeNull();
  });
  it("expires an unaccepted pending message during read even with no worker alive", async () => {
    const created = await submitStudioConversation("w", "u", "p", base); messages[0].expiresAt = new Date(Date.now() - 1000);
    const recovered: any = await readStudioConversation("w", "u", "p", { messageId: created.messageId }); expect(recovered.status).toBe("FAILED"); expect(messages[0].status).toBe("FAILED");
  });
});

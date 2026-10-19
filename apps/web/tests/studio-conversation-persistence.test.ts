import { createHash, randomUUID } from "node:crypto";
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
import { StudioConversationInput, StudioConversationIntent } from "../../../packages/contracts/src/studio-conversation";
import { parseStudioConversationIntent } from "../src/lib/studio-conversation-intent";

let conversation: any, conversations: any[], messages: any[], canvas: string, generationRequests: any[], generatedMaterials: any[];
const base = { mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6", text: "生成一张海报", references: [], documentRevision: 1, workflowRevision: 0,
  sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" } };
const reference = { referenceId: "shape:image", shapeId: "shape:image", name: "图片1", assetId: "a", assetSha256: "a".repeat(64), width: 1024, height: 1024 };
beforeEach(() => {
  vi.clearAllMocks(); f.auth.mockReset(); f.gate.mockReset(); f.generation.mockReset(); conversation = null; conversations = []; messages = []; generationRequests = []; generatedMaterials = []; canvas = "server frozen canvas";
  f.assets.mockReturnValue([{ shapeId: reference.shapeId, assetSha256: reference.assetSha256, valid: true }]);
  f.materials.mockResolvedValue([{ assetId: "a", sha256: reference.assetSha256, width: 1024, height: 1024 }]);
  f.enqueue.mockResolvedValue(false);
  Object.assign(f.db, {
    $transaction: async (fn: any) => fn(f.db),
    $queryRaw: vi.fn().mockResolvedValue([]),
    editorDocument: { findUnique: async () => ({ workspaceId: "w", revision: 1, canvas }) },
    workbenchProjectState: { findUnique: async () => ({ workspaceId: "w", workflowRevision: 0 }) },
    asset: { count: async ({ where }: any) => where.workspaceId === "w" ? where.id.in.length : 0, findFirst: async () => null },
    studioConversation: {
      upsert: async ({ create }: any) => { const existing = conversations.find(row => Object.entries(create).every(([key, value]) => row[key] === value)); conversation = existing ?? { ...create, id: `conversation-${conversations.length}`, draft: null, draftRevision: 0 }; if (!existing) conversations.push(conversation); return conversation; },
      findUnique: async ({ where }: any) => conversation ? conversations.find(row => Object.entries(where.workspaceId_userId_projectId).every(([key, value]) => row[key] === value)) ?? null : null,
      updateMany: async ({ where, data }: any) => { if (!conversation || conversation.id !== where.id || conversation.draftRevision !== where.draftRevision) return { count: 0 }; conversation.draft = data.draft; conversation.draftRevision++; return { count: 1 }; },
    },
    studioConversationMessage: {
      findUnique: async ({ where }: any) => messages.find(row => row.conversationId === where.conversationId_mutationId.conversationId && row.mutationId === where.conversationId_mutationId.mutationId) ?? null,
      findFirst: async ({ where }: any) => messages.find(row => (where.id === undefined || row.id === where.id) && row.conversationId === where.conversationId && (!where.input || where.input.path.reduce((value: any, key: string) => value?.[key], row.input) === where.input.equals)) ?? null,
      count: async ({ where }: any) => messages.filter(row => row.conversationId === where.conversationId && where.status.in.includes(row.status) && row.generationRequestId === where.generationRequestId && row.expiresAt > where.expiresAt.gt).length,
      create: async ({ data }: any) => { const row = { ...data, conversation, intent: data.intent ?? null, generationRequestId: null, status: "PENDING", error: null, createdAt: new Date() }; messages.push(row); return row; },
      findMany: async ({ where }: any) => messages.filter(row => row.conversationId === where.conversationId).slice().reverse(),
      updateMany: async ({ where, data }: any) => { const row = messages.find(value => value.id === where.id); if (!row) return { count: 0 }; Object.assign(row, data); return { count: 1 }; },
    },
    studioGenerationRequest: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn(async ({ where }: any) => generationRequests.find(row => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null),
    },
    studioGeneratedMaterial: { count: vi.fn(async ({ where }: any) => generatedMaterials.filter(row => Object.entries(where).every(([key, value]: [string, any]) => key === "status" && typeof value === "object" ? row.status !== value.not : row[key] === value)).length) },
  });
});
describe("durable conversation intake and isolated drafts (DB adapter interaction tests)", () => {
  it.each([{ psdLayerMode: "AUTO" }, { psdLayerMode: "MANUAL", psdLayerCount: 4 }])("restores PSD draft settings and passes them to normal and modify generation: %j", async options => {
    const draft = { revision: 0, text: "夏季海报", references: [], sizeSelection: base.sizeSelection, ...options };
    const saved = await saveStudioConversationDraft("w", "u", "p", draft);
    expect(saved).toMatchObject({ ...options, revision: 1 });
    expect((await readStudioConversation("w", "u", "p", {}) as any).draft).toMatchObject(options);
    for (const edit of [false, true]) {
      const input = StudioConversationInput.parse({ ...base, ...options, ...(edit ? { text: "背景改成蓝色", references: [reference], quickEditTargetId: reference.referenceId } : {}) });
      const intent = parseStudioConversationIntent(input);
      expect(intent.action).toBe(edit ? "modify" : "generate");
      expect(conversationGenerationInput("p", input, intent)).toMatchObject({ ...options, mutationId: base.mutationId });
    }
    // Disabling PSD clears both fields in the same authoritative draft.
    const cleared = await saveStudioConversationDraft("w", "u", "p", { revision: saved.revision, text: draft.text, references: [], sizeSelection: base.sizeSelection });
    expect(cleared.psdLayerMode).toBeUndefined(); expect(cleared.psdLayerCount).toBeUndefined();
    expect((await readStudioConversation("w", "u", "p", {}) as any).draft.psdLayerMode).toBeUndefined();
  });
  it("retains the original PSD request on replay and rejects changing its settings under the same mutation", async () => {
    const request = { ...base, psdLayerMode: "AUTO" };
    const accepted = await submitStudioConversation("w", "u", "p", request);
    expect(messages[0].input.psdLayerMode).toBe("AUTO");
    expect((await submitStudioConversation("w", "u", "p", request)).messageId).toBe(accepted.messageId);
    await expect(submitStudioConversation("w", "u", "p", { ...base, psdLayerMode: "MANUAL", psdLayerCount: 4 })).rejects.toMatchObject({ status: 409 });
    expect(messages).toHaveLength(1); expect(f.generation).not.toHaveBeenCalled();
  });
  it("replays a home submission after autosave without changing its frozen canvas or enqueueing another generation", async () => {
    const input = { ...base, homeStart: true, references: [reference] };
    const accepted = await submitStudioConversation("w", "u", "p", input);
    const original = messages[0].acceptedCanvas;
    canvas = "newer canvas";
    const result = await submitStudioConversation("w", "u", "p", { ...input, documentRevision: 9, workflowRevision: 4 });
    expect(result.messageId).toBe(accepted.messageId); expect(messages).toHaveLength(1);
    // New clients include an empty selection; legacy home submissions omitted
    // this contextual field. Upgrading must still recover the same request.
    expect((await submitStudioConversation("w", "u", "p", { ...input, selectedReferenceIds: [], documentRevision: 10 })).messageId).toBe(accepted.messageId);
    await expect(submitStudioConversation("w", "u", "p", { ...input, selectedReferenceIds: [reference.referenceId], documentRevision: 10 })).rejects.toMatchObject({ status: 409 });
    expect(messages[0].acceptedCanvas).toBe(original); expect(f.generation).not.toHaveBeenCalled();
    for (const changed of [{ text: "另一个需求" }, { references: [] }, { homeStart: undefined }, { psdLayerMode: "AUTO" }]) {
      await expect(submitStudioConversation("w", "u", "p", { ...input, ...changed, documentRevision: 9 })).rejects.toMatchObject({ status: 409 });
    }
    expect(messages).toHaveLength(1);
  });
  it("does not relax ordinary conversation revision replay constraints", async () => {
    await submitStudioConversation("w", "u", "p", base);
    await expect(submitStudioConversation("w", "u", "p", { ...base, documentRevision: 2 })).rejects.toMatchObject({ status: 409 });
    expect(messages).toHaveLength(1);
  });
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
  it.each([{}, { psdLayerMode: "AUTO" }, { psdLayerMode: "MANUAL", psdLayerCount: 4 }])("recovers an accepted generation with PSD options %j after an unknown acknowledgement without enqueueing again", async options => {
    await submitStudioConversation("w", "u", "p", { ...base, ...options });
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

async function decisionSource(kind: "clarification" | "correction" = "clarification", override: Record<string, unknown> = {}) {
  const input = StudioConversationInput.parse({ ...base, text: "海边度假场景，保留角色", references: [reference], ...override });
  const accepted = await submitStudioConversation("w", "u", "p", input);
  const row = messages.find(message => message.id === accepted.messageId);
  const options = [
    { id: "new-image", label: "生成新图", action: "generate" as const, targetReferenceId: null, referenceIds: [reference.referenceId], imagePrompt: "海边度假场景，保留角色，保持完整人物构图" },
    { id: "edit-image", label: "修改图片1", action: "modify" as const, targetReferenceId: reference.referenceId, referenceIds: [], imagePrompt: "保留图片中的角色，将场景改为海边度假" },
  ];
  row.status = kind === "clarification" ? "CLARIFICATION" : "SUCCEEDED";
  row.intent = StudioConversationIntent.parse({ ...parseStudioConversationIntent(input), action: kind === "clarification" ? "clarify" : "generate", targetReferenceId: null,
    referenceIds: [reference.referenceId], clarification: kind === "clarification" ? "要生成新图，还是修改图片？" : null,
    modelStatus: "SUCCEEDED", parser: "structured-model-v2", options: kind === "clarification" ? options : [], correctionOptions: kind === "correction" ? options.slice(1) : [] });
  if (kind === "correction") {
    row.generationRequestId = "source-generation";
    generationRequests.push({ id: row.generationRequestId, workspaceId: "w", userId: "u", projectId: "p", status: "SUCCEEDED" });
    generatedMaterials.push({ requestId: row.generationRequestId, workspaceId: "w", projectId: "p", status: "SUCCEEDED" });
  }
  f.enqueue.mockClear();
  const choice = (optionId = kind === "clarification" ? "new-image" : "edit-image", changes: Record<string, unknown> = {}) => ({ ...input, mutationId: randomUUID(),
    decision: { sourceMessageId: row.id, kind, optionId }, ...changes });
  return { input, row, options, choice };
}

describe("r2 structured choices use server-owned source and one durable choice (DB adapter tests, not real SQL concurrency)", () => {
  it("locks the scoped source row, freezes its chosen intent, and uses the server image prompt", async () => {
    const source = await decisionSource();
    const accepted = await submitStudioConversation("w", "u", "p", source.choice());
    expect(f.db.$queryRaw).toHaveBeenCalledTimes(1);
    const lock = f.db.$queryRaw.mock.calls[0]; expect(lock[0].join("?")).toContain("FOR UPDATE"); expect(lock.slice(1)).toEqual([source.row.id, source.row.conversationId]);
    const selected = messages.find(message => message.id === accepted.messageId);
    expect(selected.intent).toMatchObject({ action: "generate", prompt: source.input.text, imagePrompt: source.options[0].imagePrompt, referenceIds: [reference.referenceId] });
    expect(selected.acceptedCanvas).toBe(canvas); expect(selected.input.decision.sourceMessageId).toBe(source.row.id);
    expect(conversationGenerationInput("p", StudioConversationInput.parse(selected.input), StudioConversationIntent.parse(selected.intent)).prompt).toBe(source.options[0].imagePrompt);
    expect(accepted.originalInput?.text).toBe(source.input.text); expect(f.enqueue).toHaveBeenCalledWith(accepted.messageId); expect(f.generation).not.toHaveBeenCalled();
  });
  it.each([
    { text: "换成客户端伪造需求" }, { references: [] }, { sizeSelection: { ratioKey: "16:9", resolutionTier: "1K" } },
    { quickEditTargetId: reference.referenceId }, { psdLayerMode: "AUTO" }, { outputFrameId: "shape:another-frame" },
  ])("rejects changing frozen original input when selecting an option: %j", async changes => {
    const source = await decisionSource();
    await expect(submitStudioConversation("w", "u", "p", source.choice("new-image", changes))).rejects.toMatchObject({ status: 409 });
    expect(messages).toHaveLength(1); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("rejects client-injected option prompts and unavailable option IDs", async () => {
    const source = await decisionSource();
    await expect(submitStudioConversation("w", "u", "p", source.choice("new-image", { decision: { sourceMessageId: source.row.id, optionId: "new-image", kind: "clarification", imagePrompt: "client prompt" } }))).rejects.toMatchObject({ name: "ZodError" });
    await expect(submitStudioConversation("w", "u", "p", source.choice("unavailable"))).rejects.toMatchObject({ status: 422 });
    expect(messages).toHaveLength(1); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each([["w", "other-user", "p"], ["w", "u", "other-project"], ["other-workspace", "u", "p"]])("refuses another conversation's option for %s / %s / %s", async (workspaceId, userId, projectId) => {
    const source = await decisionSource();
    await expect(submitStudioConversation(workspaceId, userId, projectId, source.choice())).rejects.toMatchObject({ status: 404 });
    expect(messages).toHaveLength(1); expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.db.$queryRaw.mock.calls.at(-1).slice(1)).toEqual([source.row.id, conversation.id]);
    expect(conversation.id).not.toBe(source.row.conversationId);
  });
  it("runs current project/member authority before touching a choice source", async () => {
    const source = await decisionSource(); f.auth.mockRejectedValueOnce(Object.assign(new Error("Not a project member"), { status: 403 }));
    await expect(submitStudioConversation("w", "u", "p", source.choice())).rejects.toMatchObject({ status: 403 });
    expect(f.db.$queryRaw).not.toHaveBeenCalled(); expect(messages).toHaveLength(1); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each(["clarification", "correction"] as const)("never reissues a choice while the source model outcome is UNKNOWN (%s)", async kind => {
    const source = await decisionSource(kind); source.row.intent.modelStatus = "UNKNOWN";
    await expect(submitStudioConversation("w", "u", "p", source.choice())).rejects.toMatchObject({ status: 409 });
    expect(messages).toHaveLength(1); expect(f.enqueue).not.toHaveBeenCalled(); expect(f.generation).not.toHaveBeenCalled();
  });
  it.each(["PENDING", "RUNNING", "SUCCEEDED"])("clarification cannot launch after source status is %s", async status => {
    const source = await decisionSource(); source.row.status = status;
    await expect(submitStudioConversation("w", "u", "p", source.choice())).rejects.toMatchObject({ status: 409 }); expect(messages).toHaveLength(1);
  });
  it("rejects clarification with an already accepted generation even if its status label is stale", async () => {
    const source = await decisionSource(); source.row.generationRequestId = "already-running";
    await expect(submitStudioConversation("w", "u", "p", source.choice())).rejects.toMatchObject({ status: 409 }); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each(["missing-generation", "running-generation", "failed-generation", "missing-archive", "unfinished-archive", "foreign-generation"])("correction waits for both exact original generation and all archived images: %s", async scenario => {
    const source = await decisionSource("correction");
    if (scenario === "missing-generation") generationRequests = [];
    if (scenario === "running-generation") generationRequests[0].status = "RUNNING";
    if (scenario === "failed-generation") generationRequests[0].status = "FAILED";
    if (scenario === "missing-archive") generatedMaterials = [];
    if (scenario === "unfinished-archive") generatedMaterials.push({ ...generatedMaterials[0], status: "PENDING" });
    if (scenario === "foreign-generation") generationRequests[0].userId = "another-user";
    await expect(submitStudioConversation("w", "u", "p", source.choice())).rejects.toMatchObject({ status: 409 });
    expect(messages).toHaveLength(1); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("accepts a correction only after successful generation and archiving, preserving the original row", async () => {
    const source = await decisionSource("correction"), original = structuredClone({ input: source.row.input, intent: source.row.intent, generationRequestId: source.row.generationRequestId });
    const accepted = await submitStudioConversation("w", "u", "p", source.choice());
    expect(messages).toHaveLength(2); expect(accepted.intent).toMatchObject({ action: "modify", targetReferenceId: reference.referenceId, imagePrompt: source.options[1].imagePrompt });
    expect({ input: source.row.input, intent: source.row.intent, generationRequestId: source.row.generationRequestId }).toEqual(original);
    expect(f.db.studioGenerationRequest.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "source-generation", workspaceId: "w", userId: "u", projectId: "p", status: "SUCCEEDED" } }));
  });
  it.each(["clarification", "correction"] as const)("deduplicates the same option across different mutation IDs (%s)", async kind => {
    const source = await decisionSource(kind), firstInput = source.choice();
    const first = await submitStudioConversation("w", "u", "p", firstInput), secondInput = source.choice();
    const replay = await submitStudioConversation("w", "u", "p", secondInput);
    expect(secondInput.mutationId).not.toBe(firstInput.mutationId); expect(replay.messageId).toBe(first.messageId); expect(replay.mutationId).toBe(firstInput.mutationId);
    expect(messages).toHaveLength(2); expect(new Set(f.enqueue.mock.calls.map(([id]) => id))).toEqual(new Set([first.messageId])); expect(f.generation).not.toHaveBeenCalled();
  });
  it("refuses selecting a different option after one durable choice, including across mutation IDs", async () => {
    const source = await decisionSource(); const first = await submitStudioConversation("w", "u", "p", source.choice("new-image")); f.enqueue.mockClear();
    await expect(submitStudioConversation("w", "u", "p", source.choice("edit-image"))).rejects.toMatchObject({ status: 409 });
    expect(messages).toHaveLength(2); expect(messages[1].id).toBe(first.messageId); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each(["document", "workflow", "metadata", "hidden-shape", "foreign-bytes"])("rechecks current canvas/reference guards before a new decision is accepted: %s", async scenario => {
    const source = await decisionSource(); let expected = 409;
    if (scenario === "document") f.db.editorDocument.findUnique = async () => ({ workspaceId: "w", revision: 2, canvas });
    if (scenario === "workflow") f.db.workbenchProjectState.findUnique = async () => ({ workspaceId: "w", workflowRevision: 2 });
    if (scenario === "metadata") { f.materials.mockResolvedValue([{ assetId: "a", sha256: reference.assetSha256, width: 2048, height: 1024 }]); expected = 422; }
    if (scenario === "hidden-shape") f.assets.mockReturnValue([{ shapeId: reference.shapeId, assetSha256: reference.assetSha256, valid: false }]);
    if (scenario === "foreign-bytes") { f.materials.mockResolvedValue([{ assetId: "a", sha256: "b".repeat(64), width: 1024, height: 1024 }]); expected = 422; }
    await expect(submitStudioConversation("w", "u", "p", source.choice())).rejects.toMatchObject({ status: expected });
    expect(messages).toHaveLength(1); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("accepts a freshly saved canvas revision for the same original request and preserves PSD settings", async () => {
    const source = await decisionSource("clarification", { psdLayerMode: "MANUAL", psdLayerCount: 4 });
    canvas = "latest saved canvas"; f.db.editorDocument.findUnique = async () => ({ workspaceId: "w", revision: 3, canvas }); f.db.workbenchProjectState.findUnique = async () => ({ workspaceId: "w", workflowRevision: 2 });
    const selected = await submitStudioConversation("w", "u", "p", source.choice("new-image", { documentRevision: 3, workflowRevision: 2 }));
    const row = messages.find(message => message.id === selected.messageId); expect(row.acceptedCanvas).toBe(canvas); expect(row.input).toMatchObject({ documentRevision: 3, workflowRevision: 2, psdLayerMode: "MANUAL", psdLayerCount: 4 });
  });
  it("keeps legacy prompts compatible while preferring validated r2 imagePrompt", () => {
    const input = StudioConversationInput.parse(base), legacy = parseStudioConversationIntent(input);
    expect(conversationGenerationInput("p", input, legacy).prompt).toBe(legacy.prompt);
    expect(conversationGenerationInput("p", input, StudioConversationIntent.parse({ ...legacy, imagePrompt: "经服务端验证的更具体画面描述" })).prompt).toBe("经服务端验证的更具体画面描述");
  });
});

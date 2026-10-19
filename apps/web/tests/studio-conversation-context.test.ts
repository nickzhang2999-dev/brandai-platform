import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioConversationInput } from "../../../packages/contracts/src/studio-conversation";
import { StudioConversationModelRequest, STUDIO_CONVERSATION_THUMBNAIL_MAX_BYTES } from "../../../packages/contracts/src/studio-conversation-model";

const f = vi.hoisted(() => ({ db: {} as any, objects: vi.fn(), fetch: vi.fn(), available: vi.fn(), provider: vi.fn(), submit: vi.fn(), validate: vi.fn(), gate: vi.fn(), recover: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: f.db, Prisma: { DbNull: "DbNull" } }));
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../src/lib/s3", () => ({ getObjectStream: f.objects }));
vi.mock("../src/lib/ssrf", () => ({ safeFetch: f.fetch }));
vi.mock("@/lib/queue", () => ({ connection: {}, queuePrefix: "context-unit-only" }));
vi.mock("@/lib/studio-generation", () => ({ submitStudioGeneration: f.submit }));
vi.mock("@/lib/studio-generation-artifacts", () => ({ requireArtifactWrite: f.gate }));
vi.mock("@/lib/studio-conversation", () => ({ validateConversationReferences: f.validate,
  conversationGenerationInput: (projectId: string, input: any, intent: any) => ({ projectId, mutationId: input.mutationId, prompt: intent.prompt }),
  recoverStudioConversationGeneration: f.recover }));
vi.mock("@/lib/studio-conversation-queue", () => ({ enqueueStudioConversation: vi.fn() }));
vi.mock("@/lib/studio-conversation-model", () => ({ studioConversationModelAvailable: f.available, resolveStudioConversationModel: f.provider,
  unknownStudioConversationIntent: () => { throw new Error("Preparation must fail before an unknown paid request exists"); } }));

import { loadStudioConversationContext } from "../src/lib/studio-conversation-context";
import { runStudioConversationJob } from "../src/lib/workers/studio-conversation.worker";

const before = new Date("2026-10-19T12:00:00.000Z");
const sha256 = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const input = (extra: Record<string, unknown> = {}) => StudioConversationInput.parse({ mutationId: "831a0280-2cf1-41ba-ac94-621053c4a4c6",
  text: "根据参考图片生成一张海报", references: [], documentRevision: 1, workflowRevision: 0,
  sizeSelection: { ratioKey: "1:1", resolutionTier: "1K" }, ...extra });
let assets: any[], messages: any[], materials: any[], bodies: Map<string, Buffer>, workerRow: any;
const load = (current: ReturnType<typeof input>, signal = new AbortController().signal) => loadStudioConversationContext("w", "p", "c", before, current, signal);
const linked = (asset: any, workspaceId: string, projectId: string) => asset.workspaceId === workspaceId && asset.deprecatedAt === null
  && asset.availableForGeneration && asset.projectLinks.some((link: any) => link.projectId === projectId && link.project.workspaceId === workspaceId);
const message = (id: string, minute: number, extra = {}) => ({ id, conversationId: "c", conversation: { workspaceId: "w", projectId: "p" },
  createdAt: new Date(before.getTime() - minute * 60000), text: `需求-${id}`, intent: null, status: "SUCCEEDED", generationRequestId: null, ...extra });
const result = (requestId: string, asset: ReturnType<typeof reference>, extra = {}) => ({ requestId, assetId: asset.assetId, sha256: asset.assetSha256,
  workspaceId: "w", projectId: "p", status: "SUCCEEDED", request: { workspaceId: "w", projectId: "p", status: "SUCCEEDED" }, createdAt: before, ...extra });
function reference(id: string, body: Buffer, width: number, height: number) {
  const storageKey = `private/w/${id}.png`;
  bodies.set(storageKey, body);
  assets.push({ id, url: `https://private-storage.invalid/${storageKey}?signature=fixture-do-not-forward`, storageKey,
    workspaceId: "w", deprecatedAt: null, availableForGeneration: true, projectLinks: [{ projectId: "p", project: { workspaceId: "w" } }] });
  return { referenceId: `shape:${id}`, shapeId: `shape:${id}`, name: `图片-${id}`, assetId: id, assetSha256: sha256(body), width, height };
}
async function imageRef(id: string, width = 64, height = 32) {
  return reference(id, await sharp({ create: { width, height, channels: 4, background: { r: 20, g: 80, b: 160, alpha: 0.4 } } }).png().toBuffer(), width, height);
}
function modelRequest(current: ReturnType<typeof input>, context: Awaited<ReturnType<typeof load>>) {
  return { schemaVersion: 2, text: current.text, quickEditTargetId: current.quickEditTargetId, previousResultReferenceId: null, ...context };
}
function seedWorker(current: ReturnType<typeof input>) {
  workerRow = { id: "active-message", conversationId: "c", input: current, references: current.references, intent: null, intentModelStartedAt: null,
    acceptedCanvas: "fixture-frozen-canvas", status: "PENDING", generationRequestId: null, startedAt: null, attemptToken: null,
    expiresAt: new Date(Date.now() + 300000), createdAt: before, conversation: { workspaceId: "w", projectId: "p", userId: "u" } };
}

beforeEach(() => {
  vi.resetAllMocks(); assets = []; messages = []; materials = []; bodies = new Map(); workerRow = null;
  f.objects.mockImplementation(async (key: string) => { const body = bodies.get(key); if (!body) throw new Error("Fixture object missing"); return { body: Readable.from([body]), contentLength: body.length }; });
  f.fetch.mockRejectedValue(new Error("External network is forbidden in this fixture"));
  f.available.mockResolvedValue(true); f.recover.mockImplementation(async row => row);
  Object.assign(f.db, { $transaction: async (fn: any) => fn(f.db), $queryRaw: vi.fn().mockResolvedValue([]), user: { findUnique: vi.fn().mockResolvedValue({ isActive: true }) },
    asset: { findMany: vi.fn(async ({ where }: any) => assets.filter(asset => where.id.in.includes(asset.id) && linked(asset, where.workspaceId, where.projectLinks.some.projectId))) },
    studioGeneratedMaterial: { findMany: vi.fn(async ({ where, take }: any) => materials.filter(row => {
      const asset = assets.find(item => item.id === row.assetId);
      return (typeof where.requestId === "string" ? row.requestId === where.requestId : where.requestId.in.includes(row.requestId))
        && row.workspaceId === where.workspaceId && row.projectId === where.projectId && row.status === where.status
        && (!where.request || Object.entries(where.request).every(([key, value]) => row.request[key] === value))
        && (!where.asset || asset && linked(asset, where.asset.workspaceId, where.asset.projectLinks.some.projectId));
    }).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, take)) },
    studioConversationMessage: {
      findMany: vi.fn(async ({ where, take }: any) => messages.filter(row => row.conversationId === where.conversationId && row.createdAt < where.createdAt.lt
        && (!where.conversation || row.conversation.workspaceId === where.conversation.workspaceId && row.conversation.projectId === where.conversation.projectId)
        && (!where.generationRequestId || row.generationRequestId !== null)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).slice(0, take)),
      findUnique: vi.fn(async () => structuredClone(workerRow)),
      update: vi.fn(async ({ data }: any) => Object.assign(workerRow, data)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (where.attemptToken && where.attemptToken !== workerRow.attemptToken || typeof where.status === "string" && where.status !== workerRow.status) return { count: 0 };
        Object.assign(workerRow, data); return { count: 1 };
      }),
    },
  });
});

describe("server-only bounded conversation visual context with real image decoding", () => {
  it("returns no image reads for an empty history and no references", async () => {
    const current = input(); const context = await load(current);
    expect(context).toEqual({ references: [], history: [], selectedReferenceIds: [] });
    expect(f.objects).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
    expect(StudioConversationModelRequest.safeParse(modelRequest(current, context)).success).toBe(true);
  });

  it("limits thumbnails to four and gives quick-edit and selected images priority", async () => {
    const refs = await Promise.all(Array.from({ length: 6 }, (_, i) => imageRef(`a${i + 1}`, 1024, 512)));
    const current = input({ references: refs, quickEditTargetId: refs[5]!.referenceId, selectedReferenceIds: refs.slice(2, 5).reverse().map(ref => ref.referenceId) });
    const context = await load(current);
    expect(context.references).toHaveLength(6);
    expect(context.references.filter(ref => ref.thumbnail).map(ref => ref.referenceId)).toEqual(refs.slice(2).map(ref => ref.referenceId));
    expect(context.selectedReferenceIds).toEqual(current.selectedReferenceIds);
    expect(f.objects).toHaveBeenCalledTimes(4);
    for (const ref of context.references.filter(ref => ref.thumbnail)) {
      const thumbnail = ref.thumbnail!; const jpeg = Buffer.from(thumbnail.dataUrl.split(",")[1]!, "base64"); const meta = await sharp(jpeg).metadata();
      expect(thumbnail.width).toBe(512); expect(thumbnail.height).toBe(256); expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(thumbnail.width); expect(meta.height).toBe(thumbnail.height);
      expect(jpeg.length).toBeLessThanOrEqual(STUDIO_CONVERSATION_THUMBNAIL_MAX_BYTES);
    }
    expect(StudioConversationModelRequest.safeParse(modelRequest(current, context)).success).toBe(true);
  });

  it("does not enlarge a small image and flattens transparency before encoding", async () => {
    const ref = await imageRef("small", 32, 20); const context = await load(input({ references: [ref] }));
    const thumb = context.references[0]!.thumbnail!; const decoded = await sharp(Buffer.from(thumb.dataUrl.split(",")[1]!, "base64")).raw().toBuffer({ resolveWithObject: true });
    expect([thumb.width, thumb.height]).toEqual([32, 20]); expect(decoded.info.channels).toBe(3);
    // Semitransparent navy over white, rather than an opaque black background.
    expect(decoded.data[0]).toBeGreaterThan(140); expect(decoded.data[1]).toBeGreaterThan(160); expect(decoded.data[2]).toBeGreaterThan(190);
  });

  it("honors EXIF orientation before sizing and strips original metadata", async () => {
    const body = await sharp({ create: { width: 800, height: 400, channels: 3, background: "blue" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const ref = reference("rotated", body, 400, 800); const context = await load(input({ references: [ref] }));
    const thumb = context.references[0]!.thumbnail!; const meta = await sharp(Buffer.from(thumb.dataUrl.split(",")[1]!, "base64")).metadata();
    expect([thumb.width, thumb.height]).toEqual([256, 512]); expect(meta.orientation).toBeUndefined(); expect(meta.exif).toBeUndefined();
  });

  it("keeps a high-entropy real image within the per-thumbnail byte cap", async () => {
    const pixels = Buffer.alloc(512 * 512 * 3); let state = 9173;
    for (let i = 0; i < pixels.length; i++) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; pixels[i] = state >>> 24; }
    const body = await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer();
    const ref = reference("noise", body, 512, 512); const context = await load(input({ references: [ref] }));
    expect(Buffer.from(context.references[0]!.thumbnail!.dataUrl.split(",")[1]!, "base64").length).toBeLessThanOrEqual(128 * 1024);
  });

  it("uses only the most recent three scoped turns and caps history text at 1000 characters", async () => {
    messages.push(message("old", 4), message("first", 3), message("middle", 2, { status: "CLARIFICATION", intent: { clarification: "说明".repeat(700) } }),
      message("latest", 1, { text: "输入".repeat(700) }), message("future", -1), message("same-time", 0),
      message("other-conversation", 0.1, { conversationId: "other" }), message("other-tenant", 0.2, { conversation: { workspaceId: "other", projectId: "p" } }),
      message("other-project", 0.3, { conversation: { workspaceId: "w", projectId: "other" } }));
    const context = await load(input());
    expect(f.db.studioConversationMessage.findMany).toHaveBeenCalledWith({ where: { conversationId: "c", conversation: { workspaceId: "w", projectId: "p" }, createdAt: { lt: before } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 3, select: { text: true, intent: true, status: true, generationRequestId: true } });
    expect(context.history).toHaveLength(6); expect(context.history.map(turn => turn.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(context.history[0]!.text).toBe("需求-first"); expect(context.history[2]!.text).toBe("需求-middle");
    expect(context.history[3]!.text).toHaveLength(1000); expect(context.history[4]!.text).toHaveLength(1000);
    expect(JSON.stringify(context)).not.toMatch(/other-|需求-old|需求-future|需求-same-time/);
  });

  it("reserves one of four thumbnail slots for the last result without inventing an editable target", async () => {
    const refs = await Promise.all(Array.from({ length: 5 }, (_, i) => imageRef(`ref${i}`))); const last = await imageRef("last-result");
    messages.push(message("last", 1, { generationRequestId: "request-last", intent: { action: "modify" } })); materials.push(result("request-last", last));
    const current = input({ references: refs, quickEditTargetId: refs[4]!.referenceId, selectedReferenceIds: [refs[3]!.referenceId, refs[2]!.referenceId] });
    const context = await load(current);
    expect(context.references.filter(ref => ref.thumbnail).map(ref => ref.referenceId)).toEqual(refs.slice(2).map(ref => ref.referenceId));
    expect(context.lastResultImage).toMatchObject({ name: "上一张已保存结果（仅供理解上下文）", thumbnail: { width: 64, height: 32 } });
    expect(context.history[1]).toMatchObject({ text: "已完成1张图片。修改结果。", resultReferenceId: null });
    expect(context.references.some(ref => ref.referenceId === last.referenceId)).toBe(false); expect(context.lastResultImage).not.toHaveProperty("referenceId");
    expect(f.objects).toHaveBeenCalledTimes(4);
    expect(StudioConversationModelRequest.safeParse(modelRequest(current, context)).success).toBe(true);
    expect(StudioConversationModelRequest.safeParse({ ...modelRequest(current, context), quickEditTargetId: last.referenceId }).success).toBe(false);
    expect(StudioConversationModelRequest.safeParse({ ...modelRequest(current, context), previousResultReferenceId: last.referenceId }).success).toBe(false);
  });

  it("links an existing referenced result without sending duplicate thumbnail bytes", async () => {
    const last = await imageRef("last-in-refs"); const refs = [last, ...await Promise.all(["a", "b", "c"].map(id => imageRef(id)))];
    messages.push(message("last", 1, { generationRequestId: "request-last" })); materials.push(result("request-last", last));
    const context = await load(input({ references: refs }));
    expect(context.history[1]!.resultReferenceId).toBe(last.referenceId); expect(context.lastResultImage).toBeUndefined();
    expect(context.references.filter(ref => ref.thumbnail)).toHaveLength(4); expect(f.objects).toHaveBeenCalledTimes(4);
  });

  it("does not choose a previous target from a multi-output result", async () => {
    const a = await imageRef("a"), b = await imageRef("b"); messages.push(message("last", 1, { generationRequestId: "request-last" }));
    materials.push(result("request-last", a), result("request-last", b));
    const context = await load(input({ references: [a, b] }));
    expect(context.lastResultImage).toBeUndefined(); expect(context.history[1]).toEqual({ role: "assistant", text: "已完成2张图片。生成结果。", resultReferenceId: null });
  });

  it("binds history results and image reads to current tenant, project and live project links", async () => {
    const last = await imageRef("last"); messages.push(message("last", 1, { generationRequestId: "request-last" })); materials.push(result("request-last", last));
    await load(input());
    const liveAsset = { workspaceId: "w", availableForGeneration: true, deprecatedAt: null, projectLinks: { some: { projectId: "p", project: { workspaceId: "w" } } } };
    expect(f.db.studioGeneratedMaterial.findMany).toHaveBeenCalledWith({ where: { requestId: { in: ["request-last"] }, workspaceId: "w", projectId: "p", status: "SUCCEEDED",
      request: { workspaceId: "w", projectId: "p", status: "SUCCEEDED" }, asset: liveAsset }, select: { requestId: true, assetId: true, sha256: true }, orderBy: { createdAt: "desc" }, take: 24 });
    expect(f.db.asset.findMany).toHaveBeenCalledWith({ where: { id: { in: [last.assetId] }, ...liveAsset }, select: { id: true, url: true, storageKey: true } });
  });

  it.each(["unfinished-request", "unfinished-material", "foreign-tenant", "foreign-project", "unlinked-asset", "deprecated-asset"])
  ("does not use a %s historical output as trusted visual context", async state => {
    const last = await imageRef("last"); messages.push(message("last", 1, { generationRequestId: "request-last" }));
    const saved = result("request-last", last); materials.push(saved);
    if (state === "unfinished-request") saved.request.status = "RUNNING";
    if (state === "unfinished-material") saved.status = "PENDING";
    if (state === "foreign-tenant") saved.workspaceId = "other";
    if (state === "foreign-project") saved.projectId = "other";
    if (state === "unlinked-asset") assets[0].projectLinks = [];
    if (state === "deprecated-asset") assets[0].deprecatedAt = before;
    const context = await load(input());
    expect(context.lastResultImage).toBeUndefined(); expect(context.history[1]!.resultReferenceId).toBeNull();
    expect(context.history[1]!.text).toContain("尚无已保存的结果"); expect(f.objects).not.toHaveBeenCalled();
  });

  it.each(["foreign-tenant", "unlinked", "deprecated", "unavailable"])("rejects a %s source before any bytes can be fetched", async state => {
    const ref = await imageRef("a"); const asset = assets[0];
    if (state === "foreign-tenant") asset.workspaceId = "foreign";
    if (state === "unlinked") asset.projectLinks = [];
    if (state === "deprecated") asset.deprecatedAt = before;
    if (state === "unavailable") asset.availableForGeneration = false;
    await expect(load(input({ references: [ref] }))).rejects.toMatchObject({ status: 422, message: expect.stringContaining("已失效") });
    expect(f.objects).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });

  it("does not disclose private asset URLs, object keys or storage identifiers in model context", async () => {
    const ref = await imageRef("private-asset-id"); const context = await load(input({ references: [ref] }));
    const encoded = JSON.stringify(context);
    expect(encoded).not.toContain("https:"); expect(encoded).not.toContain("signature="); expect(encoded).not.toContain("private/w/");
    expect(context.references[0]).not.toHaveProperty("assetId"); expect(context.references[0]).not.toHaveProperty("storageKey");
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.objects.mock.calls[0]![0]).toBe("private/w/private-asset-id.png");
  });

  it("rejects byte changes even if the asset identity and dimensions are unchanged", async () => {
    const ref = await imageRef("a"); const changed = await sharp({ create: { width: 64, height: 32, channels: 3, background: "red" } }).png().toBuffer();
    bodies.set(assets[0].storageKey, changed);
    await expect(load(input({ references: [ref] }))).rejects.toMatchObject({ status: 422, message: expect.stringContaining("内容已改变") });
  });

  it.each(["exact", "one-byte-over"])("applies a cumulative 32 MiB source budget (%s), not just a per-image cap", async mode => {
    const small = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
    // Legal PNG bytes with ignored trailing padding let real sharp decode the
    // same tiny image while the actual bounded storage reader counts all bytes.
    const first = Buffer.alloc(16 * 1024 * 1024); small.copy(first);
    const second = Buffer.alloc(16 * 1024 * 1024 + (mode === "one-byte-over" ? 1 : 0)); small.copy(second);
    const refs = [reference("large-a", first, 8, 8), reference("large-b", second, 8, 8)];
    if (mode === "one-byte-over") await expect(load(input({ references: refs }))).rejects.toMatchObject({ status: 422, message: expect.stringContaining("总量过大") });
    else expect((await load(input({ references: refs }))).references.filter(ref => ref.thumbnail)).toHaveLength(2);
    expect(f.objects).toHaveBeenCalledTimes(2);
  });

  it("stops an aborted preparation before the object store or model is called", async () => {
    const ref = await imageRef("a"); const controller = new AbortController(); controller.abort(new Error("fixture canceled"));
    await expect(load(input({ references: [ref] }), controller.signal)).rejects.toThrow("fixture canceled");
    expect(f.objects).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  });
});

describe("worker integration uses the real context preflight before any paid claim", () => {
  it.each(["missing-asset", "missing-object", "invalid-image", "changed-hash"])("fails %s preparation without invoking either provider", async failure => {
    const ref = await imageRef("a");
    if (failure === "missing-asset") assets = [];
    if (failure === "missing-object") bodies.clear();
    if (failure === "invalid-image") { const bytes = Buffer.from("not-an-image"); bodies.set(assets[0].storageKey, bytes); ref.assetSha256 = sha256(bytes); }
    if (failure === "changed-hash") ref.assetSha256 = "f".repeat(64);
    seedWorker(input({ references: [ref] }));
    await runStudioConversationJob({ data: { messageId: workerRow.id } } as any);
    expect(workerRow.status).toBe("FAILED"); expect(workerRow.intent).toBeNull(); expect(workerRow.intentModelStartedAt).toBeNull();
    expect(workerRow.generationRequestId).toBeNull(); expect(f.provider).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
    expect(f.db.studioConversationMessage.updateMany.mock.calls.some(([call]: any[]) => call.data.intentModelStartedAt)).toBe(false);
  });
});

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ role: vi.fn(), project: vi.fn(), document: vi.fn(), decode: vi.fn(), source: vi.fn(),
  settings: vi.fn(), storage: vi.fn(), asset: vi.fn(), uploadReceipt: vi.fn(), generatedReceipt: vi.fn(),
  find: vi.fn(), findOrThrow: vi.fn(), findFirst: vi.fn(), list: vi.fn(), create: vi.fn(), updateMany: vi.fn(), update: vi.fn(), count: vi.fn(),
  transaction: vi.fn(), lock: vi.fn(), workspace: vi.fn(), user: vi.fn(), membership: vi.fn(), saved: vi.fn(),
  queue: vi.fn(), readBytes: vi.fn(), inspect: vi.fn(), layer: vi.fn(), budget: vi.fn(), paid: vi.fn(), poll: vi.fn(), plan: vi.fn(), usage: vi.fn(),
  put: vi.fn(), get: vi.fn(), remove: vi.fn(), assetCreate: vi.fn(), linkCreate: vi.fn(),
  generationRequest: vi.fn(), archivedSource: vi.fn(),
}));
vi.mock("../../../packages/db/src/index", () => ({ Prisma: { DbNull: "DB_NULL" }, prisma: {
  project: { findFirst: f.project }, asset: { findFirst: f.asset }, studioMaterialUpload: { findFirst: f.uploadReceipt }, studioGeneratedMaterial: { findFirst: f.generatedReceipt },
  studioDecompositionRequest: { findUnique: f.find, findUniqueOrThrow: f.findOrThrow, findFirst: f.findFirst, findMany: f.list, create: f.create, updateMany: f.updateMany, update: f.update, count: f.count }, $transaction: f.transaction,
  studioGenerationRequest: { findUnique: f.generationRequest },
} }));
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../src/lib/workspace", () => ({ requireWorkspaceRole: f.role }));
vi.mock("../src/lib/editor-documents", () => ({ readEditorDocument: f.document }));
vi.mock("../src/lib/owned-canvas-codec", () => ({ decodeOwnedCanvas: f.decode }));
vi.mock("../src/lib/owned-canvas-decomposition", () => ({ requireOwnedLayerSource: f.source }));
vi.mock("../src/lib/settings", () => ({ getEffectiveAiSettings: f.settings, getEffectiveStorage: f.storage }));
vi.mock("../src/lib/studio-generation-artifacts-image", () => ({
  STUDIO_ARTIFACT_MAX_BYTES: 32 * 1024 * 1024, artifactDeadline: (promise: unknown) => promise,
  readArtifactImageBytes: f.readBytes, inspectArtifactImage: f.inspect,
}));
vi.mock("../src/lib/studio-decomposition-images", () => ({ inspectStudioLayer: f.layer, assertStudioLayerBudget: f.budget, STUDIO_LAYER_TOTAL_PIXELS: 40_000_000 }));
vi.mock("../src/lib/studio-decomposition-queue", () => ({ enqueueStudioDecomposition: f.queue }));
vi.mock("../src/lib/ai", () => ({ ai: { decomposeSubmit: f.paid, decomposePoll: f.poll, studioLayerPlan: f.plan } }));
vi.mock("../src/lib/usage", () => ({ recordUsage: f.usage }));
vi.mock("../src/lib/s3", () => ({ uploadBuffer: f.put, getObjectStream: f.get, deleteObject: f.remove }));
vi.mock("../src/lib/image-preview", () => ({ nodeStreamToBuffer: async (stream: Readable) => {
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
} }));

import { submitStudioDecomposition, submitGeneratedStudioDecomposition, readStudioDecompositions, retryStudioLayerArchive, runStudioDecomposition, readStudioLayerAsset, dispatchStudioDecompositions, expireStudioDecompositions } from "../src/lib/studio-decomposition";
import { encryptStudioBase, decryptStudioBase } from "../src/lib/studio-generation-base";
import { newStudioLayerPlanning } from "../src/lib/studio-decomposition-planning";
import { AiServiceFailure } from "../src/lib/ai-failure";

// This suite proves service decisions with simulated persistence, not a real
// database/provider acceptance. Only the envelope crypto below runs unmocked.
const bytes = Buffer.from("synthetic layer bytes");
const digest = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const input = { projectId: "p", mutationId: "9decc9bc-6fb2-4d6f-a52d-83f90acff1ae", sourceShapeId: "shape:source", assetId: "source", assetSha256: digest(bytes), documentRevision: 4, layerCount: 2 };
const result = { layers: [0, 1].map(index => ({ imageUrl: `https://private-provider.invalid/layer-${index}?signature=synthetic-private`, width: 8, height: 8 })), usage: { provider: "FalLayerProvider", model: "unit-model", imageCount: 2 } };
const ticket = { requestId: "provider-request-1", endpointId: "fal-ai/qwen-image-layered" };
let rows: Map<string, any>, objects: Map<string, Buffer>, publishedAssets: any[], publishedLinks: any[];
let tx: any;
const row = () => rows.get("request");
const layers = () => [0, 1].map(order => ({ assetId: `sdl_request_${order}`, assetSha256: digest(bytes), order, mimeType: "image/png", width: 8, height: 8,
  sizeBytes: bytes.length, alphaBounds: { left: 0, top: 0, width: 8, height: 8 }, inkCoverage: .5, url: `/api/workspaces/w/assets/sdl_request_${order}/raw` }));
function seed(overrides: Record<string, unknown> = {}) {
  const value = { id: "request", workspaceId: "w", userId: "u", ...input, payloadHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    sourceWidth: 8, sourceHeight: 8, sourceObjectKey: "w/source.png", sourceMimeType: "image/png", sourceSizeBytes: bytes.length,
    status: "PENDING", providerStartedAt: null, outputJson: null, publishedLayers: [], archiveExpiresAt: null, archiveToken: null, archivingStartedAt: null,
    objectKeys: [], intent: null, error: null, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), ...overrides };
  rows.set(value.id, value); return value;
}
function matches(value: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, expected]: [string, any]) => {
    if (key === "OR") return expected.some((part: any) => matches(value, part));
    if (key === "AND") return expected.every((part: any) => matches(value, part));
    if (key === "workspaceId_userId_projectId_mutationId") return matches(value, expected);
    const actual = value[key];
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
    if (expected && typeof expected === "object") return Object.entries(expected).every(([op, target]: [string, any]) => {
      if (op === "in") return target.includes(actual);
      if (op === "gt") return actual > target;
      if (op === "lte") return actual <= target;
      if (op === "lt") return actual < target;
      if (op === "equals") return JSON.stringify(actual) === JSON.stringify(target === "DB_NULL" ? null : target);
      if (op === "not") return actual !== (target === "DB_NULL" ? null : target);
      throw new Error(`Unsupported fixture predicate ${op}`);
    });
    return actual === expected;
  });
}
function patch(value: any, data: any) { for (const [key, item] of Object.entries(data)) value[key] = item === "DB_NULL" ? null : structuredClone(item); }
beforeEach(() => {
  vi.resetAllMocks(); rows = new Map(); objects = new Map(); publishedAssets = []; publishedLinks = [];
  vi.stubEnv("SETTINGS_ENC_KEY", "synthetic-decomposition-test-key"); vi.stubEnv("AUTH_SECRET", "synthetic-auth-test-key");
  f.role.mockResolvedValue({ role: "EDITOR" }); f.project.mockResolvedValue({ id: "p", archivedAt: null });
  f.document.mockResolvedValue({ revision: 4, readOnly: false, canvas: "owned-document", checksum: "document-checksum" });
  f.decode.mockResolvedValue({ items: [] }); f.source.mockReturnValue({ id: input.sourceShapeId });
  f.settings.mockResolvedValue({ layer: { provider: "fal", apiKey: "synthetic-configured-key" } }); f.storage.mockResolvedValue({ configured: true });
  f.asset.mockResolvedValue({ id: "source", workspaceId: "w", storageKey: "w/source.png", sizeBytes: bytes.length, mimeType: "image/png" });
  f.uploadReceipt.mockResolvedValue({ objectKey: "w/source.png", width: 8, height: 8, sizeBytes: bytes.length, mimeType: "image/png" }); f.generatedReceipt.mockResolvedValue(null);
  f.find.mockImplementation(({ where }) => [...rows.values()].find(value => matches(value, where)) ?? null);
  f.findOrThrow.mockImplementation(async (args) => { const value = await f.find(args); if (!value) throw new Error("fixture absent"); return value; });
  f.findFirst.mockImplementation(f.find.getMockImplementation()!);
  f.list.mockImplementation(({ where, select }) => [...rows.values()].filter(value => matches(value, where)).map(value => select
    ? Object.fromEntries(Object.keys(select).filter(key => select[key]).map(key => [key, value[key]])) : value));
  f.count.mockImplementation(({ where }) => [...rows.values()].filter(value => matches(value, where)).length);
  f.create.mockImplementation(({ data }) => seed(data));
  f.updateMany.mockImplementation(({ where, data }) => { const selected = [...rows.values()].filter(value => matches(value, where)); selected.forEach(value => patch(value, data)); return { count: selected.length }; });
  f.update.mockImplementation(({ where, data }) => { const value = rows.get(where.id); if (!value) throw new Error("fixture absent"); patch(value, data); return value; });
  f.lock.mockResolvedValue([{ id: "locked" }]); f.workspace.mockResolvedValue({ ownerId: "u" }); f.user.mockResolvedValue({ isActive: true }); f.membership.mockResolvedValue({ role: "EDITOR" });
  f.saved.mockResolvedValue({ workspaceId: "w", revision: 4, checksum: "document-checksum" }); f.queue.mockResolvedValue(true);
  f.readBytes.mockResolvedValue(bytes); f.inspect.mockResolvedValue({ sha256: digest(bytes), width: 8, height: 8, sizeBytes: bytes.length, mimeType: "image/png" });
  f.layer.mockResolvedValue({ ...layers()[0], body: bytes, hasTransparency: true }); f.paid.mockResolvedValue(ticket);
  f.poll.mockResolvedValue({ status: "COMPLETED", result });
  f.put.mockImplementation(async (body: Buffer, _mime: string, _prefix: string, _signal: AbortSignal, key: string) => { objects.set(key, Buffer.from(body)); return { key }; });
  f.get.mockImplementation(async (key: string) => { const body = objects.get(key); if (!body) throw new Error("fixture object absent"); return { body: Readable.from(body), contentLength: body.length }; });
  f.assetCreate.mockImplementation(({ data }) => { publishedAssets.push(structuredClone(data)); return data; });
  f.linkCreate.mockImplementation(({ data }) => { publishedLinks.push(structuredClone(data)); return data; });
  tx = { $queryRaw: f.lock, studioDecompositionRequest: { findUnique: f.find, findUniqueOrThrow: f.findOrThrow, count: f.count, create: f.create, updateMany: f.updateMany, update: f.update },
    brandWorkspace: { findUnique: f.workspace }, user: { findUnique: f.user }, membership: { findUnique: f.membership }, project: { findFirst: f.project }, editorDocument: { findUnique: f.saved },
    asset: { findFirst: f.asset, create: f.assetCreate }, projectAsset: { create: f.linkCreate } };
  tx.studioGeneratedMaterial = { findUnique: f.archivedSource };
  f.transaction.mockImplementation(async fn => {
    const backup = structuredClone({ rows: [...rows], assets: publishedAssets, links: publishedLinks });
    try { return await fn(tx); } catch (error) { rows = new Map(backup.rows); publishedAssets = backup.assets; publishedLinks = backup.links; throw error; }
  });
});

describe("automatic PSD accepts only a real generated archive, never an unsaved browser image", () => {
  function automaticSource(overrides: Record<string, unknown> = {}) {
    const generation = { id: "generation-request", workspaceId: "w", userId: "u", projectId: "p", mutationId: input.mutationId, documentRevision: 4, status: "SUCCEEDED", jobData: { studioPsdLayerCount: 2 } };
    const material = { outputId: "generated-output", requestId: generation.id, workspaceId: "w", userId: "u", projectId: "p", assetId: "source", sha256: input.assetSha256,
      status: "SUCCEEDED", objectKey: "w/source.png", width: 8, height: 8, sizeBytes: bytes.length, mimeType: "image/png", request: { jobData: generation.jobData }, ...overrides };
    f.generationRequest.mockResolvedValue(generation); f.uploadReceipt.mockResolvedValue(null);
    f.generatedReceipt.mockResolvedValue(material); f.archivedSource.mockResolvedValue(material);
    return { generation, material };
  }
  it("registers a durable deterministic request without a canvas selection/document, lost-receipt replay pays nothing", async () => {
    automaticSource(); f.document.mockRejectedValue(new Error("must not require canvas insertion"));
    const first = await submitGeneratedStudioDecomposition("generation-request");
    const replay = await submitGeneratedStudioDecomposition("generation-request");
    expect(first.requestId).toBe(replay.requestId); expect(first.sourceShapeId).toMatch(/^shape:generated-[a-f0-9]{40}$/);
    expect(f.create).toHaveBeenCalledOnce(); expect(f.document).not.toHaveBeenCalled(); expect(f.paid).not.toHaveBeenCalled();
    expect(f.generatedReceipt).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "w", projectId: "p", status: "SUCCEEDED" }) }));
  });
  it("registers an AUTO generation continuation with no client count and a durable pending semantic plan", async () => {
    const { generation } = automaticSource(); generation.jobData = { studioPsdLayerMode: "AUTO" } as any;
    const received = await submitGeneratedStudioDecomposition("generation-request");
    expect(received).toMatchObject({ layerMode: "AUTO", analysisStatus: "PENDING", analysisSummary: null });
    expect(row().planningJson).toEqual(newStudioLayerPlanning("AUTO")); expect(row().layerCount).toBe(2);
    await submitGeneratedStudioDecomposition("generation-request"); expect(f.create).toHaveBeenCalledOnce(); expect(f.paid).not.toHaveBeenCalled(); expect(f.plan).not.toHaveBeenCalled();
  });
  it("does not register or pay when PSD was unselected or the original archive is unavailable", async () => {
    const { generation } = automaticSource(); generation.jobData = {} as any;
    await expect(submitGeneratedStudioDecomposition("generation-request")).rejects.toMatchObject({ status: 409 });
    generation.jobData = { studioPsdLayerCount: 2 }; f.generatedReceipt.mockResolvedValue(null);
    await expect(submitGeneratedStudioDecomposition("generation-request")).rejects.toMatchObject({ status: 409 });
    expect(f.create).not.toHaveBeenCalled(); expect(f.paid).not.toHaveBeenCalled();
  });
  it("preserves EXACT source protection in the automatic intake", async () => {
    const { material } = automaticSource(); material.request.jobData = { assetUsages: [{ mode: "EXACT" }] } as any;
    await expect(submitGeneratedStudioDecomposition("generation-request")).rejects.toMatchObject({ status: 409 });
    expect(f.create).not.toHaveBeenCalled(); expect(f.queue).not.toHaveBeenCalled(); expect(f.paid).not.toHaveBeenCalled();
  });
  it("rejects excessive PSD memory before creating or charging a decomposition", async () => {
    automaticSource({ width: 16384, height: 16384 });
    await expect(submitGeneratedStudioDecomposition("generation-request")).rejects.toMatchObject({ status: 422, message: expect.stringContaining("PSD") });
    expect(f.create).not.toHaveBeenCalled(); expect(f.paid).not.toHaveBeenCalled();
  });
  it("fences changed source ownership/hash and downgraded actors inside the transaction", async () => {
    automaticSource(); f.archivedSource.mockResolvedValue({ ...await f.generatedReceipt(), userId: "other" });
    await expect(submitGeneratedStudioDecomposition("generation-request")).rejects.toMatchObject({ status: 409 }); expect(f.create).not.toHaveBeenCalled();
    automaticSource(); f.workspace.mockResolvedValue({ ownerId: "someone" }); f.membership.mockResolvedValue({ role: "VIEWER" });
    await expect(submitGeneratedStudioDecomposition("generation-request")).rejects.toMatchObject({ status: 403 }); expect(f.create).not.toHaveBeenCalled(); expect(f.paid).not.toHaveBeenCalled();
  });
  it("keeps missing configuration as an independent persistent FAILED receipt with the original generation untouched", async () => {
    const { generation } = automaticSource(); await submitGeneratedStudioDecomposition(generation.id);
    f.settings.mockResolvedValue({ layer: { provider: "mock", apiKey: "" } });
    await runStudioDecomposition("request"); await runStudioDecomposition("request");
    expect(row().status).toBe("FAILED"); expect(row().error).toContain("尚未配置"); expect(row().providerStartedAt).toBeNull();
    expect(generation.status).toBe("SUCCEEDED"); expect(f.paid).not.toHaveBeenCalled(); expect(f.usage).not.toHaveBeenCalled();
    expect(await readStudioDecompositions("w", "u", { projectId: "p", requestId: "request" })).toMatchObject({ status: "FAILED", layers: [], error: expect.stringContaining("尚未配置") });
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("Studio decomposition intake: simulated DB, never a provider call", () => {
  it("accepts the saved scoped source once, then dispatches only its durable request ID", async () => {
    const received = await submitStudioDecomposition("w", "u", input);
    expect(received.status).toBe("PENDING"); expect(received.layers).toEqual([]);
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.queue).toHaveBeenCalledWith("request"); expect(f.paid).not.toHaveBeenCalled();
    expect(f.asset).toHaveBeenCalledWith({ where: { id: "source", workspaceId: "w", deprecatedAt: null, availableForGeneration: true, projectLinks: { some: { projectId: "p", project: { workspaceId: "w" } } } } });
    expect(f.uploadReceipt.mock.calls[0]![0].where).toMatchObject({ workspaceId: "w", assetId: "source", sha256: input.assetSha256, task: { workspaceId: "w", kind: "STUDIO_UPLOAD", status: "SUCCEEDED" } });
  });
  it.each([401, 403, 404])("retains authentication/role/scope denial %i before intake", async status => {
    f.role.mockRejectedValue(Object.assign(new Error("denied"), { status }));
    await expect(submitStudioDecomposition("w", "u", input)).rejects.toMatchObject({ status });
    expect(f.create).not.toHaveBeenCalled(); expect(f.settings).not.toHaveBeenCalled(); expect(f.paid).not.toHaveBeenCalled();
  });
  it("does not accept a project outside the actual workspace", async () => {
    f.project.mockResolvedValue(null); await expect(submitStudioDecomposition("w", "u", input)).rejects.toMatchObject({ status: 404 });
    expect(f.project).toHaveBeenCalledWith({ where: { id: "p", workspaceId: "w" }, select: { id: true, archivedAt: true } }); expect(f.create).not.toHaveBeenCalled();
  });
  it.each(["archived", "stale", "readOnly", "changedBeforeCommit"])("rejects %s source state before acceptance", async scenario => {
    if (scenario === "archived") f.project.mockResolvedValue({ id: "p", archivedAt: new Date() });
    if (scenario === "stale") f.document.mockResolvedValue({ revision: 5, readOnly: false });
    if (scenario === "readOnly") f.document.mockResolvedValue({ revision: 4, readOnly: true });
    if (scenario === "changedBeforeCommit") f.saved.mockResolvedValue({ workspaceId: "w", revision: 5, checksum: "different" });
    await expect(submitStudioDecomposition("w", "u", input)).rejects.toMatchObject({ status: 409 }); expect(f.create).not.toHaveBeenCalled(); expect(f.paid).not.toHaveBeenCalled();
  });
  it("rejects a revoked editor inside the intake transaction", async () => {
    f.workspace.mockResolvedValue({ ownerId: "someone-else" }); f.membership.mockResolvedValue({ role: "VIEWER" });
    await expect(submitStudioDecomposition("w", "u", input)).rejects.toMatchObject({ status: 403 }); expect(f.create).not.toHaveBeenCalled();
  });
  it.each(["mockProvider", "missingStorage", "foreignAsset", "wrongArchive"])("fails closed for %s before provider submission", async scenario => {
    if (scenario === "mockProvider") f.settings.mockResolvedValue({ layer: { provider: "mock", apiKey: "synthetic" } });
    if (scenario === "missingStorage") f.storage.mockResolvedValue({ configured: false });
    if (scenario === "foreignAsset") f.asset.mockResolvedValue(null);
    if (scenario === "wrongArchive") f.uploadReceipt.mockResolvedValue({ objectKey: "other/source.png", width: 8, height: 8, mimeType: "image/png", sizeBytes: bytes.length });
    await expect(submitStudioDecomposition("w", "u", input)).rejects.toThrow(); expect(f.create).not.toHaveBeenCalled(); expect(f.paid).not.toHaveBeenCalled();
  });
  it("protects an existing EXACT composition from a model which may repaint it", async () => {
    f.uploadReceipt.mockResolvedValue(null); f.generatedReceipt.mockResolvedValue({ objectKey: "w/source.png", width: 8, height: 8, mimeType: "image/png", sizeBytes: bytes.length, request: { jobData: { assetUsages: [{ mode: "EXACT" }] } } });
    await expect(submitStudioDecomposition("w", "u", input)).rejects.toMatchObject({ status: 409 }); expect(f.create).not.toHaveBeenCalled();
  });
  it("replays a lost receipt with identical immutable input despite a newer document, without creating or paying again", async () => {
    seed({ providerStartedAt: new Date(), status: "RUNNING" }); f.document.mockRejectedValue(new Error("must not reread changed canvas"));
    const received = await submitStudioDecomposition("w", "u", input);
    expect(received.requestId).toBe("request"); expect(f.create).not.toHaveBeenCalled(); expect(f.document).not.toHaveBeenCalled(); expect(f.queue).not.toHaveBeenCalled(); expect(f.paid).not.toHaveBeenCalled();
  });
  it("rejects mutation reuse with a changed layer count", async () => {
    seed(); await expect(submitStudioDecomposition("w", "u", { ...input, layerCount: 3 })).rejects.toMatchObject({ status: 409 }); expect(f.queue).not.toHaveBeenCalled(); expect(f.paid).not.toHaveBeenCalled();
  });
});

describe("private receipts and archive-only retry", () => {
  it("allows a viewer to read public state without returning private provider URLs or original intent", async () => {
    seed({ status: "FAILED", providerStartedAt: new Date(), outputJson: { result, publishedLayers: null }, intent: "private synthetic intent", archiveExpiresAt: new Date(Date.now() + 60_000) });
    const view = await readStudioDecompositions("w", "reader", { projectId: "p", requestId: "request" });
    expect(f.role).toHaveBeenCalledWith("w", "reader", "VIEWER"); expect(view).toMatchObject({ status: "FAILED", layers: [], canRetryArchive: true });
    expect(JSON.stringify(view)).not.toMatch(/private-provider|synthetic-private|private synthetic intent|outputJson|sourceObjectKey/);
    expect(f.list.mock.calls[0]![0].select).not.toHaveProperty("outputJson");
    expect(f.paid).not.toHaveBeenCalled();
  });
  it("retries only the saved model result without checking or calling a provider", async () => {
    seed({ status: "FAILED", providerStartedAt: new Date(), outputJson: { result, publishedLayers: null }, archiveExpiresAt: new Date(Date.now() + 60_000) });
    expect(await retryStudioLayerArchive("w", "u", { projectId: "p", requestId: "request" })).toMatchObject({ status: "RUNNING" });
    expect(f.queue).toHaveBeenCalledWith("request"); expect(f.paid).not.toHaveBeenCalled(); expect(f.settings).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  });
  it.each(["absentOutput", "expiredOutput", "foreignRequest"])("cannot manufacture an archive retry for %s", async scenario => {
    seed({ status: "FAILED", providerStartedAt: new Date(), outputJson: { result, publishedLayers: null }, archiveExpiresAt: new Date(Date.now() + 60_000) });
    if (scenario === "absentOutput") row().outputJson = null;
    if (scenario === "expiredOutput") row().archiveExpiresAt = new Date(0);
    if (scenario === "foreignRequest") row().workspaceId = "other";
    await expect(retryStudioLayerArchive("w", "u", { projectId: "p", requestId: "request" })).rejects.toThrow(); expect(f.queue).not.toHaveBeenCalled(); expect(f.paid).not.toHaveBeenCalled();
  });
});

describe("once-only worker claim and atomic publication", () => {
  it("claims before exactly one explicit real-provider call and publishes encrypted complete layers", async () => {
    seed(); await runStudioDecomposition("request");
    expect(f.paid).toHaveBeenCalledTimes(1);
    expect(f.paid).toHaveBeenCalledWith(expect.objectContaining({ layerCount: 2, providerRetryPolicy: "never", imageUrl: `data:image/png;base64,${bytes.toString("base64")}` }),
      expect.objectContaining({ requireRealLayerProvider: true, signal: expect.any(AbortSignal), maxResponseBytes: 4096 }));
    const claimIndex = f.updateMany.mock.calls.findIndex(([args]) => args.data.providerStartedAt);
    expect(claimIndex).toBeGreaterThanOrEqual(0); expect(f.updateMany.mock.invocationCallOrder[claimIndex]).toBeLessThan(f.paid.mock.invocationCallOrder[0]!);
    expect(row().status).toBe("SUCCEEDED"); expect(row().outputJson).toBeNull(); expect(row().publishedLayers).toEqual(layers());
    expect(publishedAssets).toHaveLength(2); expect(publishedLinks).toHaveLength(2); expect(f.put).toHaveBeenCalledTimes(2);
    for (const [index, asset] of publishedAssets.entries()) {
      const encrypted = objects.get(asset.storageKey)!;
      expect(encrypted).not.toEqual(bytes); expect(encrypted.includes(bytes)).toBe(false);
      expect(decryptStudioBase(encrypted, { workspaceId: "w", projectId: "p", outputId: `request_${index}` })).toEqual(bytes);
      expect(asset.availableForGeneration).toBe(false);
    }
    await runStudioDecomposition("request"); expect(f.paid).toHaveBeenCalledTimes(1);
  });
  it("does not accept a mock result even if it contains plausible image URLs", async () => {
    seed(); f.poll.mockResolvedValue({ status: "COMPLETED", result: { ...result, usage: { provider: "MockLayerProvider", imageCount: 2 } } });
    await runStudioDecomposition("request");
    expect(row().status).toBe("FAILED"); expect(row().outputJson).toMatchObject({ queue: ticket, result: null }); expect(f.put).not.toHaveBeenCalled(); expect(publishedAssets).toHaveLength(0);
    expect(String(row().error)).not.toContain("private-provider");
  });
  it("does not invoke a provider when actual source bytes fail the saved SHA", async () => {
    seed(); f.inspect.mockResolvedValue({ sha256: "0".repeat(64), width: 8, height: 8, sizeBytes: bytes.length, mimeType: "image/png" });
    await runStudioDecomposition("request"); expect(row().status).toBe("FAILED"); expect(row().providerStartedAt).toBeNull(); expect(f.paid).not.toHaveBeenCalled();
  });
  it("leaves an ambiguous already-started provider call untouched", async () => {
    seed({ status: "RUNNING", providerStartedAt: new Date(), outputJson: null });
    await runStudioDecomposition("request"); expect(row().status).toBe("RUNNING"); expect(f.paid).not.toHaveBeenCalled(); expect(f.readBytes).not.toHaveBeenCalled();
  });
  it("a preclaim loser cannot fail a different runner's paid claim", async () => {
    seed(); const otherClaim = new Date(Date.now() - 1);
    f.readBytes.mockImplementation(async () => { row().status = "RUNNING"; row().providerStartedAt = otherClaim; throw new Error("synthetic read failure"); });
    await runStudioDecomposition("request"); expect(row().status).toBe("RUNNING"); expect(row().providerStartedAt).toEqual(otherClaim); expect(f.paid).not.toHaveBeenCalled();
  });
  it("rolls back partial publication, preserves the provider result, and retries storage without a second paid call", async () => {
    seed(); let calls = 0;
    f.assetCreate.mockImplementation(({ data }) => { if (++calls === 2) throw new Error("synthetic second asset failure"); publishedAssets.push(structuredClone(data)); return data; });
    await runStudioDecomposition("request");
    expect(f.paid).toHaveBeenCalledTimes(1); expect(row().status).toBe("FAILED"); expect(row().outputJson.result).toEqual(result);
    expect(row().publishedLayers).toEqual([]); expect(publishedAssets).toEqual([]); expect(publishedLinks).toEqual([]);
    const failed = await readStudioDecompositions("w", "u", { projectId: "p", requestId: "request" });
    expect(failed).toMatchObject({ layers: [], canRetryArchive: true });
    f.assetCreate.mockImplementation(({ data }) => { publishedAssets.push(structuredClone(data)); return data; });
    await retryStudioLayerArchive("w", "u", { projectId: "p", requestId: "request" });
    await runStudioDecomposition("request");
    expect(row().status).toBe("SUCCEEDED"); expect(f.paid).toHaveBeenCalledTimes(1); expect(publishedAssets).toHaveLength(2);
  });
  it("does not publish ordinary opaque image layers as a transparent decomposition", async () => {
    seed(); f.layer.mockResolvedValue({ ...layers()[0], body: bytes, hasTransparency: false });
    await runStudioDecomposition("request"); expect(row().status).toBe("FAILED"); expect(publishedAssets).toEqual([]); expect(row().publishedLayers).toEqual([]);
  });
  it("keeps faint layers alongside two substantive layers without another provider call", async () => {
    const three = { ...result, layers: [...result.layers, result.layers[0]!] };
    seed({ status: "RUNNING", providerStartedAt: new Date(), outputJson: { result: three, publishedLayers: null }, archiveExpiresAt: new Date(Date.now() + 60_000) });
    f.layer.mockResolvedValueOnce({ ...layers()[0], body: bytes, hasTransparency: true, inkCoverage: 0 });
    await runStudioDecomposition("request");
    expect(row().status).toBe("SUCCEEDED"); expect(publishedAssets).toHaveLength(3);
    expect(row().publishedLayers[0].inkCoverage).toBe(0); expect(f.paid).not.toHaveBeenCalled();
  });
  it("rejects a group of only faint noise and records the actual validation reason", async () => {
    seed(); f.layer.mockResolvedValue({ ...layers()[0], body: bytes, hasTransparency: true, inkCoverage: 0 });
    await runStudioDecomposition("request");
    expect(row().status).toBe("FAILED"); expect(publishedAssets).toHaveLength(0);
    expect(row().error).toContain("不足两个具有有效内容");
    expect(row().outputJson.result).toEqual(result); expect(f.paid).toHaveBeenCalledTimes(1);
  });
  it("retains no raw upstream message when provider submission fails", async () => {
    seed(); f.paid.mockRejectedValue(new Error("https://private-provider.invalid?secret=synthetic-private user intent"));
    await runStudioDecomposition("request"); expect(row().status).toBe("FAILED"); expect(String(row().error)).not.toMatch(/https|secret|synthetic-private|user intent/);
    await runStudioDecomposition("request"); expect(f.paid).toHaveBeenCalledTimes(1);
  });
});

describe("durable provider queue: restart recovery without paid resubmission", () => {
  function queued(overrides: Record<string, unknown> = {}) {
    return seed({ status: "RUNNING", providerStartedAt: new Date(), outputJson: { queue: ticket, result: null, publishedLayers: null },
      archiveExpiresAt: new Date(Date.now() + 86_400_000), ...overrides });
  }
  it("persists the submission ticket before polling and resumes after a simulated worker restart", async () => {
    vi.useFakeTimers(); seed(); f.poll.mockResolvedValueOnce({ status: "IN_QUEUE" });
    await runStudioDecomposition("request");
    expect(row()).toMatchObject({ status: "RUNNING", outputJson: { queue: ticket, result: null } });
    const savedTicket = f.updateMany.mock.calls.findIndex(([args]) => args.data.outputJson?.queue && !args.data.outputJson.pollAfter);
    expect(f.updateMany.mock.invocationCallOrder[savedTicket]).toBeLessThan(f.poll.mock.invocationCallOrder[0]!);
    expect(publishedAssets).toHaveLength(0); expect(f.paid).toHaveBeenCalledOnce();
    // Dispatch is the durable outbox; restarting needs only the database row.
    await dispatchStudioDecompositions(); expect(f.queue).toHaveBeenCalledWith("request");
    await runStudioDecomposition("request"); expect(f.poll).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 15_001);
    await runStudioDecomposition("request");
    expect(row().status).toBe("SUCCEEDED"); expect(f.paid).toHaveBeenCalledOnce(); expect(f.poll).toHaveBeenCalledTimes(2);
    expect(f.poll.mock.calls[1]![0]).toEqual({ ...ticket, providerRetryPolicy: "never" });
    expect(f.poll.mock.calls[1]![1].requestId).toMatch(/^sdr_[a-f0-9]{32}$/);
  });
  it("keeps the same ticket through status-read timeout and retries only safe reads", async () => {
    vi.useFakeTimers(); queued(); const recoveryDeadline = row().archiveExpiresAt;
    f.poll.mockRejectedValueOnce(new AiServiceFailure({ code: "PROVIDER_TIMEOUT", stage: "provider", upstreamStatus: null }));
    await runStudioDecomposition("request");
    expect(row().status).toBe("RUNNING"); expect(row().outputJson.queue).toEqual(ticket);
    expect(row().archiveExpiresAt).toEqual(recoveryDeadline); expect(f.paid).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 15_001); await runStudioDecomposition("request");
    expect(row().status).toBe("SUCCEEDED"); expect(f.poll).toHaveBeenCalledTimes(2); expect(f.paid).not.toHaveBeenCalled();
  });
  it("allows status and result reads that each finish within 15s even when their combined time exceeds 20s", async () => {
    vi.useFakeTimers(); queued();
    // Native AbortSignal.timeout does not share Vitest's virtual clock. Route
    // deadlines through timer-backed real AbortControllers for this timing test.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Deadline exceeded", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    f.poll.mockImplementationOnce(async (_request, options: { signal: AbortSignal }) => {
      for (const _stage of ["status", "result"]) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 12_000);
          options.signal.addEventListener("abort", () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
        });
        options.signal.throwIfAborted();
      }
      return { status: "COMPLETED", result };
    });
    try {
      const running = runStudioDecomposition("request");
      await vi.advanceTimersByTimeAsync(0);
      expect(f.poll).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(24_000);
      await running;
      expect(row().status).toBe("SUCCEEDED"); expect(publishedAssets).toHaveLength(2);
      expect(f.paid).not.toHaveBeenCalled();
    } finally { timeout.mockRestore(); }
  });
  it("does not overlap duplicate deliveries while a status read is in flight", async () => {
    queued(); let resolve!: (value: unknown) => void;
    f.poll.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = runStudioDecomposition("request");
    await vi.waitFor(() => expect(f.poll).toHaveBeenCalledOnce());
    await runStudioDecomposition("request"); expect(f.poll).toHaveBeenCalledOnce();
    resolve({ status: "IN_PROGRESS" }); await first;
    expect(row().status).toBe("RUNNING"); expect(f.paid).not.toHaveBeenCalled();
  });
  it("recovers a timed-out task by GET only within its original fixed recovery window", async () => {
    vi.useFakeTimers(); queued({ expiresAt: new Date(Date.now() + 1_000) });
    const recoveryDeadline = row().archiveExpiresAt;
    vi.setSystemTime(Date.now() + 1_001); await expireStudioDecompositions();
    expect(row().status).toBe("FAILED");
    expect(await readStudioDecompositions("w", "u", { projectId: "p", requestId: "request" })).toMatchObject({ canRetryArchive: true, layers: [] });
    await retryStudioLayerArchive("w", "u", { projectId: "p", requestId: "request" });
    expect(row().archiveExpiresAt).toEqual(recoveryDeadline);
    await runStudioDecomposition("request");
    expect(row().status).toBe("SUCCEEDED"); expect(f.poll).toHaveBeenCalledOnce(); expect(f.paid).not.toHaveBeenCalled();
  });
  it("never publishes a late poll response over an expired task or recovery attempt", async () => {
    vi.useFakeTimers(); queued({ expiresAt: new Date(Date.now() + 1_000) });
    f.poll.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 1_001); await expireStudioDecompositions();
      await retryStudioLayerArchive("w", "u", { projectId: "p", requestId: "request" });
      return { status: "COMPLETED", result };
    });
    await runStudioDecomposition("request");
    expect(row().status).toBe("RUNNING"); expect(row().outputJson.result).toBeNull();
    expect(publishedAssets).toHaveLength(0); expect(f.paid).not.toHaveBeenCalled();
  });
  it("retains a late submission receipt for explicit recovery without restarting it", async () => {
    vi.useFakeTimers(); seed({ expiresAt: new Date(Date.now() + 1_000) });
    f.paid.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 1_001); await expireStudioDecompositions(); return ticket; });
    await runStudioDecomposition("request");
    expect(row()).toMatchObject({ status: "FAILED", outputJson: { queue: ticket, result: null } });
    expect(f.poll).not.toHaveBeenCalled();
    await retryStudioLayerArchive("w", "u", { projectId: "p", requestId: "request" });
    await runStudioDecomposition("request");
    expect(row().status).toBe("SUCCEEDED"); expect(f.paid).toHaveBeenCalledOnce();
  });
  it("does not re-POST an ambiguous lost submit response and does not invent a recovery ticket", async () => {
    seed(); f.paid.mockRejectedValueOnce(new AiServiceFailure({ code: "PROVIDER_TIMEOUT", stage: "provider", upstreamStatus: null }));
    await runStudioDecomposition("request"); await runStudioDecomposition("request");
    expect(row().status).toBe("FAILED"); expect(row().outputJson).toBeNull(); expect(row().archiveExpiresAt).toBeNull();
    expect(f.paid).toHaveBeenCalledOnce(); expect(f.poll).not.toHaveBeenCalled();
    await expect(retryStudioLayerArchive("w", "u", { projectId: "p", requestId: "request" })).rejects.toMatchObject({ status: 409 });
  });
  it("blocks queued result checks and publication after actor or source access changes", async () => {
    queued(); f.workspace.mockResolvedValue({ ownerId: "another" }); f.membership.mockResolvedValue({ role: "VIEWER" });
    await runStudioDecomposition("request");
    expect(row().status).toBe("FAILED"); expect(f.poll).not.toHaveBeenCalled(); expect(f.paid).not.toHaveBeenCalled();
    expect(publishedAssets).toHaveLength(0);
  });
  it("retires expired tickets and refuses any further queue recovery", async () => {
    queued({ status: "FAILED", expiresAt: new Date(0), archiveExpiresAt: new Date(0) });
    await dispatchStudioDecompositions(); expect(row().outputJson).toBeNull();
    await expect(retryStudioLayerArchive("w", "u", { projectId: "p", requestId: "request" })).rejects.toMatchObject({ status: 409 });
    expect(f.paid).not.toHaveBeenCalled(); expect(f.poll).not.toHaveBeenCalled();
  });
});

describe("private raw layers: real AES and simulated storage", () => {
  const key = "w/studio-layer-assets/p/request/attempt/0.bin";
  const asset = { id: "sdl_request_0", storageKey: key };
  const signal = () => AbortSignal.timeout(1000);
  function ready() {
    seed({ status: "SUCCEEDED", providerStartedAt: new Date(), publishedLayers: layers(), objectKeys: [key] });
    objects.set(key, encryptStudioBase(bytes, { workspaceId: "w", projectId: "p", outputId: "request_0" }));
  }
  it("only returns bytes matching the published task, identity and plaintext checksum", async () => {
    ready(); expect(await readStudioLayerAsset("w", asset, signal())).toEqual(bytes);
  });
  it.each(["wrongWorkspace", "wrongProject", "wrongAsset", "notPublished", "unknownObject"])("rejects %s before any storage read", async scenario => {
    ready(); let selected = asset;
    if (scenario === "wrongWorkspace") row().workspaceId = "other";
    if (scenario === "wrongProject") row().projectId = "other";
    if (scenario === "wrongAsset") selected = { ...asset, id: "sdl_other_0" };
    if (scenario === "notPublished") row().status = "FAILED";
    if (scenario === "unknownObject") row().objectKeys = [];
    await expect(readStudioLayerAsset("w", selected, signal())).rejects.toThrow(); expect(f.get).not.toHaveBeenCalled();
  });
  it.each(["wrongAad", "tamperedCiphertext", "wrongPlaintext"])("rejects %s with the real authenticated envelope/integrity checks", async scenario => {
    ready();
    if (scenario === "wrongAad") objects.set(key, encryptStudioBase(bytes, { workspaceId: "another", projectId: "p", outputId: "request_0" }));
    if (scenario === "tamperedCiphertext") { const body = objects.get(key)!; body[body.length - 1] = body[body.length - 1]! ^ 1; }
    if (scenario === "wrongPlaintext") objects.set(key, encryptStudioBase(Buffer.from("other valid encrypted bytes"), { workspaceId: "w", projectId: "p", outputId: "request_0" }));
    await expect(readStudioLayerAsset("w", asset, signal())).rejects.toMatchObject({ status: 422 });
  });
});

describe("semantic AUTO planning: simulated once-only paid boundaries, not model quality acceptance", () => {
  const plan = (count = 3) => ({ revision: "semantic-layer-plan-r1", plan: { layerCount: count, summary: "检测到主体、文字与背景，可独立编辑。",
    groups: Array.from({ length: count }, (_, index) => ({ name: `内容${index + 1}`, description: `可见组${index + 1}` })) },
    usage: { provider: "HttpVLMProvider", model: "fixture-vision", latencyMs: 21 } });
  beforeEach(() => {
    f.settings.mockResolvedValue({ layer: { provider: "fal", apiKey: "synthetic-layer" }, vlm: { provider: "openai", apiKey: "synthetic-vision" } });
    f.plan.mockResolvedValue(plan());
    f.poll.mockResolvedValue({ status: "COMPLETED", result: { ...result, layers: [...result.layers, { imageUrl: "https://private-provider.invalid/layer-2", width: 8, height: 8 }] } });
  });
  it("chooses the actual count from a persisted image analysis before one decomposition call, independent of the placeholder", async () => {
    seed({ planningJson: newStudioLayerPlanning("AUTO") });
    await runStudioDecomposition("request"); await runStudioDecomposition("request");
    expect(f.plan).toHaveBeenCalledOnce(); expect(f.paid).toHaveBeenCalledOnce();
    expect(f.plan.mock.calls[0]![0]).toMatchObject({ maxLayers: 10, providerRetryPolicy: "never", imageUrl: expect.stringContaining("data:image/png;base64,") });
    expect(f.paid.mock.calls[0]![0]).toMatchObject({ layerCount: 3, intent: expect.stringContaining("内容3"), providerRetryPolicy: "never" });
    expect(row()).toMatchObject({ status: "SUCCEEDED", layerCount: 3, planningJson: { status: "SUCCEEDED", result: plan() } });
    expect(await readStudioDecompositions("w", "u", { projectId: "p", requestId: "request" })).toMatchObject({ layerMode: "AUTO", analysisStatus: "SUCCEEDED", layerCount: 3, layers: expect.any(Array) });
    expect(f.usage).toHaveBeenCalledWith(expect.objectContaining({ kind: "LAYER_PLAN", imageCount: 1, model: "fixture-vision" }));
    expect(row().publishedLayers.every((layer: any) => !layer.name?.startsWith("内容"))).toBe(true);
  });
  it("resumes a persisted analysis after worker loss without another vision call", async () => {
    seed({ layerCount: 3, planningJson: { ...newStudioLayerPlanning("AUTO"), status: "SUCCEEDED", startedAt: new Date().toISOString(), result: plan() } });
    await runStudioDecomposition("request");
    expect(f.plan).not.toHaveBeenCalled(); expect(f.paid).toHaveBeenCalledOnce(); expect(row().status).toBe("SUCCEEDED");
  });
  it("does not duplicate an ambiguous in-flight analysis delivery", async () => {
    seed({ status: "RUNNING", planningJson: { ...newStudioLayerPlanning("AUTO"), status: "RUNNING", startedAt: new Date().toISOString() } });
    await runStudioDecomposition("request");
    expect(f.plan).not.toHaveBeenCalled(); expect(f.paid).not.toHaveBeenCalled(); expect(row().status).toBe("RUNNING");
  });
  it("single-attempt analysis errors preserve the original and cannot be retried automatically or downgraded to fixed count", async () => {
    seed({ planningJson: newStudioLayerPlanning("AUTO") }); f.plan.mockRejectedValue(new Error("https://upstream.invalid/secret?token=fixture"));
    await runStudioDecomposition("request"); await runStudioDecomposition("request");
    expect(f.plan).toHaveBeenCalledOnce(); expect(f.paid).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: "FAILED", providerStartedAt: null, planningJson: { status: "FAILED" }, publishedLayers: [] });
    expect(row().error).not.toMatch(/upstream|secret|token/);
    expect(await readStudioDecompositions("w", "u", { projectId: "p", requestId: "request" })).toMatchObject({ layerMode: "AUTO", analysisStatus: "FAILED" });
  });
  it("unsupported or unsafe content plans do not enter the decomposition model", async () => {
    seed({ planningJson: newStudioLayerPlanning("AUTO") }); f.plan.mockRejectedValue(new Error("图片服务请求失败（HTTP 422）"));
    await runStudioDecomposition("request"); expect(f.paid).not.toHaveBeenCalled(); expect(row().error).toContain("未得到可靠的可拆分内容方案");
  });
  it("preserves the actual safe vision rejection and never calls the layer model or retries analysis", async () => {
    seed({ planningJson: newStudioLayerPlanning("AUTO") });
    f.plan.mockRejectedValue(new AiServiceFailure({ code: "PROVIDER_REQUEST_REJECTED", stage: "provider", upstreamStatus: 400 }));
    await runStudioDecomposition("request"); await runStudioDecomposition("request");
    expect(f.plan).toHaveBeenCalledOnce(); expect(f.paid).not.toHaveBeenCalled();
    expect(row().error).toContain("图片内容分析服务拒绝了请求"); expect(row().error).toContain("HTTP 400");
    expect(row().error).toContain("未调用分层模型"); expect(row().planningJson.status).toBe("FAILED");
  });
  it("budgeted maximum is computed from native dimensions before calling the analysis and never silently downsamples", async () => {
    seed({ sourceWidth: 2048, sourceHeight: 2048, planningJson: newStudioLayerPlanning("AUTO") });
    f.inspect.mockResolvedValue({ sha256: digest(bytes), width: 2048, height: 2048, sizeBytes: bytes.length, mimeType: "image/png" });
    f.plan.mockResolvedValue(plan(10)); await runStudioDecomposition("request");
    expect(f.plan.mock.calls[0]![0].maxLayers).toBe(9); expect(f.paid).not.toHaveBeenCalled(); expect(row().status).toBe("FAILED");
  });
  it("rejects missing real vision configuration at AUTO intake and preserves manual legacy availability", async () => {
    f.settings.mockResolvedValue({ layer: { provider: "fal", apiKey: "synthetic-layer" }, vlm: { provider: "mock", apiKey: "" } });
    const { layerCount: _count, ...auto } = input;
    await expect(submitStudioDecomposition("w", "u", { ...auto, layerMode: "AUTO" })).rejects.toMatchObject({ status: 503 });
    expect(f.create).not.toHaveBeenCalled(); expect(f.plan).not.toHaveBeenCalled();
    await submitStudioDecomposition("w", "u", input); expect(f.create).toHaveBeenCalledOnce();
  });
  it("accepts a verified published layer as a source, decrypts its exact bytes and checks its original ancestry", async () => {
    const key = "w/studio-layer-assets/p/parent/attempt/0.bin";
    const parent = seed({ id: "parent", status: "SUCCEEDED", publishedLayers: layers().map((value, index) => ({ ...value, assetId: `sdl_parent_${index}` })), objectKeys: [key] });
    objects.set(key, encryptStudioBase(bytes, { workspaceId: "w", projectId: "p", outputId: "parent_0" }));
    f.asset.mockImplementation(async ({ where }) => where.id === "sdl_parent_0"
      ? { id: "sdl_parent_0", storageKey: key, sizeBytes: bytes.length, mimeType: "image/png" }
      : { id: "source", storageKey: "w/source.png", sizeBytes: bytes.length, mimeType: "image/png" });
    f.uploadReceipt.mockImplementation(async ({ where }) => where.assetId === "source" ? { objectKey: "w/source.png", width: 8, height: 8, sizeBytes: bytes.length, mimeType: "image/png" } : null);
    seed({ assetId: "sdl_parent_0", sourceObjectKey: key, planningJson: newStudioLayerPlanning("AUTO") });
    await runStudioDecomposition("request");
    expect(row().status).toBe("SUCCEEDED"); expect(parent.status).toBe("SUCCEEDED"); expect(f.plan).toHaveBeenCalledOnce(); expect(f.get).toHaveBeenCalledWith(key, expect.any(AbortSignal));
    expect(f.asset.mock.calls.some(([args]) => args.where.id === "source")).toBe(true);
  });
  it("an exact-material ancestor cannot be washed through a previously published child layer", async () => {
    const key = "w/studio-layer-assets/p/parent/attempt/0.bin";
    seed({ id: "parent", status: "SUCCEEDED", publishedLayers: layers().map((value, index) => ({ ...value, assetId: `sdl_parent_${index}` })), objectKeys: [key] });
    f.asset.mockImplementation(async ({ where }) => ({ id: where.id, storageKey: where.id === "source" ? "w/source.png" : key, sizeBytes: bytes.length, mimeType: "image/png" }));
    f.uploadReceipt.mockResolvedValue(null);
    f.generatedReceipt.mockImplementation(async ({ where }) => where.assetId === "source" ? { objectKey: "w/source.png", width: 8, height: 8, sizeBytes: bytes.length, mimeType: "image/png", request: { jobData: { assetUsages: [{ mode: "EXACT" }] } } } : null);
    seed({ assetId: "sdl_parent_0", sourceObjectKey: key, planningJson: newStudioLayerPlanning("AUTO") });
    await runStudioDecomposition("request"); expect(row().status).toBe("FAILED"); expect(f.plan).not.toHaveBeenCalled(); expect(f.paid).not.toHaveBeenCalled();
  });
});

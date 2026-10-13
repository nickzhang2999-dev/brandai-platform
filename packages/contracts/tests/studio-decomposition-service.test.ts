import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ role: vi.fn(), project: vi.fn(), document: vi.fn(), decode: vi.fn(), source: vi.fn(),
  settings: vi.fn(), storage: vi.fn(), asset: vi.fn(), uploadReceipt: vi.fn(), generatedReceipt: vi.fn(),
  find: vi.fn(), findOrThrow: vi.fn(), findFirst: vi.fn(), list: vi.fn(), create: vi.fn(), updateMany: vi.fn(), update: vi.fn(), count: vi.fn(),
  transaction: vi.fn(), lock: vi.fn(), workspace: vi.fn(), user: vi.fn(), membership: vi.fn(), saved: vi.fn(),
  queue: vi.fn(), readBytes: vi.fn(), inspect: vi.fn(), layer: vi.fn(), budget: vi.fn(), paid: vi.fn(), usage: vi.fn(),
  put: vi.fn(), get: vi.fn(), remove: vi.fn(), assetCreate: vi.fn(), linkCreate: vi.fn(),
}));
vi.mock("../../db/src/index", () => ({ Prisma: { DbNull: "DB_NULL" }, prisma: {
  project: { findFirst: f.project }, asset: { findFirst: f.asset }, studioMaterialUpload: { findFirst: f.uploadReceipt }, studioGeneratedMaterial: { findFirst: f.generatedReceipt },
  studioDecompositionRequest: { findUnique: f.find, findUniqueOrThrow: f.findOrThrow, findFirst: f.findFirst, findMany: f.list, create: f.create, updateMany: f.updateMany, update: f.update, count: f.count }, $transaction: f.transaction,
} }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/workspace", () => ({ requireWorkspaceRole: f.role }));
vi.mock("../../../apps/web/src/lib/editor-documents", () => ({ readEditorDocument: f.document }));
vi.mock("../../../apps/web/src/lib/owned-canvas-codec", () => ({ decodeOwnedCanvas: f.decode }));
vi.mock("../../../apps/web/src/lib/owned-canvas-decomposition", () => ({ requireOwnedLayerSource: f.source }));
vi.mock("../../../apps/web/src/lib/settings", () => ({ getEffectiveAiSettings: f.settings, getEffectiveStorage: f.storage }));
vi.mock("../../../apps/web/src/lib/studio-generation-artifacts-image", () => ({
  STUDIO_ARTIFACT_MAX_BYTES: 32 * 1024 * 1024, artifactDeadline: (promise: unknown) => promise,
  readArtifactImageBytes: f.readBytes, inspectArtifactImage: f.inspect,
}));
vi.mock("../../../apps/web/src/lib/studio-decomposition-images", () => ({ inspectStudioLayer: f.layer, assertStudioLayerBudget: f.budget }));
vi.mock("../../../apps/web/src/lib/studio-decomposition-queue", () => ({ enqueueStudioDecomposition: f.queue }));
vi.mock("../../../apps/web/src/lib/ai", () => ({ ai: { decompose: f.paid } }));
vi.mock("../../../apps/web/src/lib/usage", () => ({ recordUsage: f.usage }));
vi.mock("../../../apps/web/src/lib/s3", () => ({ uploadBuffer: f.put, getObjectStream: f.get, deleteObject: f.remove }));
vi.mock("../../../apps/web/src/lib/image-preview", () => ({ nodeStreamToBuffer: async (stream: Readable) => {
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
} }));

import { submitStudioDecomposition, readStudioDecompositions, retryStudioLayerArchive, runStudioDecomposition, readStudioLayerAsset } from "../../../apps/web/src/lib/studio-decomposition";
import { encryptStudioBase, decryptStudioBase } from "../../../apps/web/src/lib/studio-generation-base";

// This suite proves service decisions with simulated persistence, not a real
// database/provider acceptance. Only the envelope crypto below runs unmocked.
const bytes = Buffer.from("synthetic layer bytes");
const digest = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const input = { projectId: "p", mutationId: "9decc9bc-6fb2-4d6f-a52d-83f90acff1ae", sourceShapeId: "shape:source", assetId: "source", assetSha256: digest(bytes), documentRevision: 4, layerCount: 2 };
const result = { layers: [0, 1].map(index => ({ imageUrl: `https://private-provider.invalid/layer-${index}?signature=synthetic-private`, width: 8, height: 8 })), usage: { provider: "FalLayerProvider", model: "unit-model", imageCount: 2 } };
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
      if (op === "equals") return actual === (target === "DB_NULL" ? null : target);
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
  f.layer.mockResolvedValue({ ...layers()[0], body: bytes, hasTransparency: true }); f.paid.mockResolvedValue(result);
  f.put.mockImplementation(async (body: Buffer, _mime: string, _prefix: string, _signal: AbortSignal, key: string) => { objects.set(key, Buffer.from(body)); return { key }; });
  f.get.mockImplementation(async (key: string) => { const body = objects.get(key); if (!body) throw new Error("fixture object absent"); return { body: Readable.from(body), contentLength: body.length }; });
  f.assetCreate.mockImplementation(({ data }) => { publishedAssets.push(structuredClone(data)); return data; });
  f.linkCreate.mockImplementation(({ data }) => { publishedLinks.push(structuredClone(data)); return data; });
  tx = { $queryRaw: f.lock, studioDecompositionRequest: { findUnique: f.find, findUniqueOrThrow: f.findOrThrow, count: f.count, create: f.create, updateMany: f.updateMany, update: f.update },
    brandWorkspace: { findUnique: f.workspace }, user: { findUnique: f.user }, membership: { findUnique: f.membership }, project: { findFirst: f.project }, editorDocument: { findUnique: f.saved },
    asset: { findFirst: f.asset, create: f.assetCreate }, projectAsset: { create: f.linkCreate } };
  f.transaction.mockImplementation(async fn => {
    const backup = structuredClone({ rows: [...rows], assets: publishedAssets, links: publishedLinks });
    try { return await fn(tx); } catch (error) { rows = new Map(backup.rows); publishedAssets = backup.assets; publishedLinks = backup.links; throw error; }
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("Studio decomposition intake: simulated DB, never a provider call", () => {
  it("accepts the saved scoped source once, then dispatches only its durable request ID", async () => {
    const received = await submitStudioDecomposition("w", "u", input);
    expect(received.status).toBe("PENDING"); expect(received.layers).toEqual([]);
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.queue).toHaveBeenCalledWith("request"); expect(f.paid).not.toHaveBeenCalled();
    expect(f.asset).toHaveBeenCalledWith({ where: { id: "source", workspaceId: "w", deprecatedAt: null, projectLinks: { some: { projectId: "p", project: { workspaceId: "w" } } } } });
    expect(f.uploadReceipt.mock.calls[0]![0].where).toMatchObject({ workspaceId: "w", projectId: "p", assetId: "source", sha256: input.assetSha256 });
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
      expect.objectContaining({ requireRealLayerProvider: true, signal: expect.any(AbortSignal), maxResponseBytes: 32 * 1024 * 1024 }));
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
    seed(); f.paid.mockResolvedValue({ ...result, usage: { provider: "MockLayerProvider", imageCount: 2 } });
    await runStudioDecomposition("request");
    expect(row().status).toBe("FAILED"); expect(row().outputJson).toBeNull(); expect(f.put).not.toHaveBeenCalled(); expect(publishedAssets).toHaveLength(0);
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
  it("retains no raw upstream message when provider submission fails", async () => {
    seed(); f.paid.mockRejectedValue(new Error("https://private-provider.invalid?secret=synthetic-private user intent"));
    await runStudioDecomposition("request"); expect(row().status).toBe("FAILED"); expect(String(row().error)).not.toMatch(/https|secret|synthetic-private|user intent/);
    await runStudioDecomposition("request"); expect(f.paid).toHaveBeenCalledTimes(1);
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

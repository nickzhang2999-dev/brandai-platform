import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ asset: vi.fn(), generated: vi.fn(), upload: vi.fn(), materials: vi.fn(), query: vi.fn(), get: vi.fn(), base: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { asset: { findFirst: f.asset }, studioGeneratedMaterial: { findUnique: f.generated }, studioMaterialUpload: { findUnique: f.upload } } }));
vi.mock("../../../apps/web/src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../apps/web/src/lib/studio-project-materials", () => ({ listStudioProjectMaterials: f.materials }));
vi.mock("../../../apps/web/src/lib/studio-generation-base", () => ({ readStudioCleanBase: f.base, requireStudioBaseEncryption: vi.fn() }));
vi.mock("../../../apps/web/src/lib/s3", () => ({ getObjectStream: f.get }));
vi.mock("../../../apps/web/src/lib/ssrf", () => ({ safeFetch: vi.fn() }));
vi.mock("../../../apps/web/src/lib/watermark", () => ({ applyWatermarksToImage: vi.fn() }));
import { StudioEditSourceSnapshot, resolveStudioEditSource, inspectStudioEditSource, loadStudioEditSource, lockStudioEditPublicationSource, assertStudioEditNotModelReference } from "../../../apps/web/src/lib/studio-generation-edit";
import { ExactAssetTransform } from "../src/resource-usage";

const url = "/api/workspaces/w/assets/a/raw", shapeId = "shape:image";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const png = (color: string) => sharp({ create: { width: 3, height: 2, channels: 4, background: color } }).png().toBuffer();
const canvas = (props: Record<string, unknown> = {}, shape: Record<string, unknown> = {}, extra = {}) => "SHAKKERDATA://" + gzipSync(JSON.stringify({ tldrawSnapshot: { document: { schema: {}, store: {
  "page:one": { id: "page:one", typeName: "page", name: "Page" },
  [shapeId]: { id: shapeId, typeName: "shape", type: "c-image", parentId: "page:one", index: "a1", x: 0, y: 0, rotation: 0, props: { url, w: 30, h: 20, ...props }, ...shape }, ...extra,
} } } })).toString("base64");
const deadline = () => AbortSignal.timeout(5_000);
let raw: Buffer, base: Buffer, asset: any, generated: any, upload: any, db: any;
const target = () => ({ shapeId, assetSha256: digest(raw) });
const resolve = (saved = canvas()) => resolveStudioEditSource(db, "w", "p", target(), saved);
const cleanBase = () => ({ schemaVersion: 1, encoding: "aes-256-gcm-v1", keyRevision: "c".repeat(24), objectKey: "private-base-key",
  sha256: digest(base), width: 3, height: 2, mimeType: "image/png", sizeBytes: base.length });
function generatedSource(processing: Record<string, unknown> = {}) {
  asset.generationVersionId = "version";
  generated = { outputId: "output", requestId: "request", workspaceId: "w", projectId: "p", userId: "original-collaborator", status: "SUCCEEDED", assetId: "a", versionId: "version",
    sha256: digest(raw), width: 3, height: 2, mimeType: "image/png", objectKey: asset.storageKey,
    version: { id: "version", generationId: "generation", imageUrl: asset.url, params: {}, width: 3, height: 2, generation: { id: "generation", workspaceId: "w", projectId: "p" } },
    request: { id: "request", workspaceId: "w", projectId: "p", userId: "original-collaborator", generationId: "generation", status: "SUCCEEDED" },
    output: { id: "output", requestId: "request", workspaceId: "w", projectId: "p", params: { studioPostprocess: { watermarkOverlays: [], brandRules: [], assetSha256: {}, ...processing } } } };
}
function exactLayout() {
  const transform = ExactAssetTransform.parse({ widthRatio: .5 });
  return { target: { width: 3, height: 2 }, frame: { shapeId: "shape:frame", width: 30, height: 20, pageId: "page:one", pageTransform: [1, 0, 0, 1, 0, 0] },
    layers: [{ shapeId: "shape:locked", assetId: "locked", sha256: "b".repeat(64), width: 1, height: 1, displayWidth: 15, displayHeight: 15, relativeTransform: [1, 0, 0, 1, 0, 0], transform }],
    assetUsages: [{ assetId: "locked", mode: "EXACT", order: 0, exactTransform: transform }] };
}

beforeEach(async () => {
  vi.resetAllMocks(); raw = await png("#874edd"); base = await png("#ff0000"); generated = null;
  asset = { id: "a", workspaceId: "w", url: "http://storage.invalid/w/a", storageKey: "w/a", generationVersionId: null, mimeType: "image/png", availableForGeneration: true, deprecatedAt: null };
  upload = { workspaceId: "w", projectId: "p", assetId: "a", sha256: digest(raw), width: 3, height: 2, mimeType: "image/png", objectKey: "w/a", taskId: "upload-task",
    task: { workspaceId: "w", kind: "STUDIO_UPLOAD", status: "SUCCEEDED" } };
  f.asset.mockImplementation(async () => structuredClone(asset)); f.generated.mockImplementation(async () => structuredClone(generated)); f.upload.mockImplementation(async () => structuredClone(upload));
  f.materials.mockImplementation(async () => [{ assetId: "a", sha256: digest(raw), mimeType: "image/png", width: 3, height: 2, url }]);
  f.get.mockImplementation(async () => ({ body: Readable.from(raw), contentLength: raw.length })); f.base.mockImplementation(async () => base);
  f.query.mockResolvedValue([{ id: "a", taskId: "upload-task" }]);
  db = { asset: { findFirst: f.asset }, studioGeneratedMaterial: { findUnique: f.generated }, studioMaterialUpload: { findUnique: f.upload }, $queryRaw: f.query };
});

describe("authorized whole-image modification source", () => {
  it("resolves the saved shape URL plus digest to an uploaded original without exposing URLs or keys", async () => {
    const value = await resolve();
    expect(value.snapshot).toMatchObject({ assetId: "a", shapeId, sha256: digest(raw), width: 3, height: 2 });
    expect(value.postprocess).toBeNull(); expect(StudioEditSourceSnapshot.safeParse(value.snapshot).success).toBe(true);
    expect(JSON.stringify(value)).not.toMatch(/storageKey|objectKey|https?:|imageUrl/);
    expect(f.asset).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "a", workspaceId: "w", availableForGeneration: true, deprecatedAt: null,
      projectLinks: { some: { projectId: "p", project: { workspaceId: "w" } } } }) }));
    const loaded = await loadStudioEditSource("w", "p", value.snapshot, deadline());
    expect(loaded).toMatchObject({ imageUrl: `data:image/png;base64,${raw.toString("base64")}`, sha256: digest(raw), width: 3, height: 2 });
    expect(f.get).toHaveBeenCalledWith("w/a", expect.any(AbortSignal)); expect(f.base).not.toHaveBeenCalled();
  });

  it("does not authorize a guessed digest, foreign URL, absent membership or ambiguous asset", async () => {
    await expect(resolveStudioEditSource(db, "w", "p", { ...target(), assetSha256: "a".repeat(64) }, canvas())).rejects.toThrow();
    await expect(resolve(canvas({ url: "/api/workspaces/foreign/assets/a/raw" }))).rejects.toThrow();
    f.asset.mockResolvedValueOnce(null); await expect(resolve()).rejects.toThrow();
    f.materials.mockResolvedValueOnce([{ assetId: "a", sha256: digest(raw), mimeType: "image/png", url }, { assetId: "b", sha256: digest(raw), mimeType: "image/png", url }]);
    await expect(resolve()).rejects.toMatchObject({ status: 422 });
  });

  it.each([
    { cropRegion: { x: .1, y: 0, w: .9, h: 1 } }, { adjust: { exposure: 1 } }, { adjust: null }, { adjust: { unsupported: 0 } },
    { opacity: .5 }, { radius: 2 }, { flipX: true }, { flipY: true }, { w: 50 },
  ])("rejects rendered target effects instead of silently editing a different whole image: %j", async props => {
    await expect(resolve(canvas(props))).rejects.toMatchObject({ status: 422 });
  });

  it("accepts neutral processing and native frame overflow, but rejects explicit clipping and parent effects", async () => {
    await expect(resolve(canvas({ cropRegion: { x: 0, y: 0, w: 1, h: 1 }, adjust: { exposure: 0 }, flipX: false, radius: 0 }))).resolves.toHaveProperty("snapshot");
    await expect(resolve(canvas({}, { rotation: .2 }))).rejects.toMatchObject({ status: 422 });
    await expect(resolve(canvas({}, { opacity: .2 }))).rejects.toMatchObject({ status: 422 });
    const frame = { id: "shape:frame", typeName: "shape", type: "frame", parentId: "page:one", index: "a1", x: 0, y: 0, rotation: 0, props: { w: 20, h: 20 } };
    await expect(resolve(canvas({}, { parentId: frame.id, x: 0, y: 0 }, { [frame.id]: frame }))).resolves.toHaveProperty("snapshot");
    for (const props of [{ ...frame.props, clipContent: true }, { ...frame.props, flipX: true }]) {
      await expect(resolve(canvas({}, { parentId: frame.id }, { [frame.id]: { ...frame, props } }))).rejects.toMatchObject({ status: 422 });
    }
  });

  it.each([{ hidden: true }, { isHidden: true }, { visible: false }, { visibility: "hidden" }, { meta: { isUploading: true } },
    { meta: { agentHiddenUntilFit: true } }, { scaleX: 1 }, { transform: [1, 0, 0, 1, 0, 0] }, { clipPath: "mask" },
    { parentId: undefined }, { parentId: "shape:missing" }, { parentId: shapeId }, { parentId: "page:missing" }])("rejects hidden, extra-transformed or invalid-ancestry target: %j", async shape => {
    await expect(resolve(canvas({}, shape))).rejects.toMatchObject({ status: 422 });
  });

  it("validates the generated artifact/output/request/generation/version/asset chain", async () => {
    generatedSource(); const resolved = await resolve();
    expect(resolved.snapshot).toMatchObject({ versionId: "version", outputId: "output", sourceGenerationId: "generation" });
    expect(resolved.postprocess).toEqual({});
    for (const corrupt of [
      (r: any) => { r.workspaceId = "foreign"; }, (r: any) => { r.projectId = "foreign"; }, (r: any) => { r.status = "FAILED"; },
      (r: any) => { r.output.workspaceId = "foreign"; }, (r: any) => { r.output.id = "other"; }, (r: any) => { r.output.requestId = "other"; },
      (r: any) => { r.request.userId = "other"; }, (r: any) => { r.request.status = "FAILED"; }, (r: any) => { r.request.generationId = "other"; },
      (r: any) => { r.version.generation.projectId = "foreign"; }, (r: any) => { r.version.id = "other"; }, (r: any) => { r.version.imageUrl = "other"; },
    ]) {
      generatedSource(); corrupt(generated); await expect(resolve()).rejects.toThrow();
    }
    generatedSource(); asset.generationVersionId = "other"; await expect(resolve()).rejects.toThrow();
    generated = null; await expect(resolve()).rejects.toThrow();
  });

  it("edits unprocessed generated pixels directly, but prefers a retained base even without effects", async () => {
    generatedSource(); let resolved = await resolve();
    expect((await loadStudioEditSource("w", "p", resolved.snapshot, deadline())).sha256).toBe(digest(raw));
    expect(f.base).not.toHaveBeenCalled();
    generatedSource({ cleanBase: cleanBase() }); resolved = await resolve();
    const loaded = await loadStudioEditSource("w", "p", resolved.snapshot, deadline());
    expect(loaded.sha256).toBe(digest(base)); expect(resolved.snapshot.sha256).toBe(digest(raw));
    expect(f.base).toHaveBeenCalledWith(cleanBase(), { workspaceId: "w", projectId: "p", outputId: "output" }, expect.any(AbortSignal));
  });

  it("rejects historical postprocessed images without a protected base, including missing EXACT recipes", async () => {
    generatedSource({ watermarkOverlays: [{ text: "Brand", enabled: true }] }); await expect(resolve()).rejects.toMatchObject({ status: 422 });
    generatedSource({ exactLayout: exactLayout() }); await expect(resolve()).rejects.toMatchObject({ status: 422 });
    generatedSource(); generated.version.params = { appliedBrandLogoAssetId: "logo" }; await expect(resolve()).rejects.toMatchObject({ status: 422 });
    generatedSource({ cleanBase: cleanBase() }); generated.version.params = { appliedExactAssetIds: ["locked"] }; await expect(resolve()).rejects.toMatchObject({ status: 422 });
  });

  it("inherits only validated EXACT layout, not old watermarks or private base keys", async () => {
    generatedSource({ exactLayout: exactLayout(), cleanBase: cleanBase(), watermarkOverlays: [{ text: "old brand", enabled: true }] });
    const value = await resolve();
    expect(Object.keys(value.postprocess!)).toEqual(["exactLayout"]);
    expect(value.postprocess!.exactLayout).toEqual(exactLayout());
    expect(JSON.stringify(value)).not.toContain("private-base-key");
    generated.output.params.studioPostprocess.exactLayout.assetUsages[0].exactTransform = {
      ...generated.output.params.studioPostprocess.exactLayout.assetUsages[0].exactTransform, widthRatio: .2,
    };
    await expect(resolve()).rejects.toMatchObject({ status: 422 });
  });

  it("rejects the flattened EXACT target as a model reference by original asset ID", async () => {
    generatedSource({ exactLayout: exactLayout(), cleanBase: cleanBase() });
    const { snapshot, postprocess } = await resolve();
    expect(() => assertStudioEditNotModelReference(snapshot, postprocess!.exactLayout, [{ assetId: snapshot.assetId, sha256: "f".repeat(64), source: "asset:a" }]))
      .toThrow(expect.objectContaining({ status: 422 }));
  });

  it("rejects a same-byte alias of the flattened EXACT target as a model reference", async () => {
    generatedSource({ exactLayout: exactLayout(), cleanBase: cleanBase() });
    const { snapshot, postprocess } = await resolve();
    expect(() => assertStudioEditNotModelReference(snapshot, postprocess!.exactLayout, [{ assetId: "another-authorized-copy", sha256: snapshot.sha256, source: "asset:copy" }]))
      .toThrow(expect.objectContaining({ status: 422 }));
    expect(() => assertStudioEditNotModelReference(snapshot, postprocess!.exactLayout, [{ assetId: "different-image", sha256: "f".repeat(64) }])).not.toThrow();
  });

  it("permits normal target references when no EXACT recipe is inherited", async () => {
    const { snapshot } = await resolve();
    const sameTarget = [{ assetId: snapshot.assetId, sha256: snapshot.sha256 }];
    expect(() => assertStudioEditNotModelReference(snapshot, null, sameTarget)).not.toThrow();
    expect(() => assertStudioEditNotModelReference(snapshot, undefined, sameTarget)).not.toThrow();
  });

  it("freezes storage and original recipe identity without invalidating for a later compliance report", async () => {
    generatedSource({ cleanBase: cleanBase() }); const { snapshot } = await resolve();
    generated.version.params.studioCompliance = { taskId: "finished-later" };
    await expect(inspectStudioEditSource(db, "w", "p", snapshot)).resolves.toHaveProperty("snapshot", snapshot);
    generated.output.params.studioPostprocess.brandRules = [{ id: "changed" }];
    await expect(inspectStudioEditSource(db, "w", "p", snapshot)).rejects.toThrow();
    generatedSource({ cleanBase: cleanBase() }); asset.url = "http://storage.invalid/w/changed"; generated.version.imageUrl = asset.url;
    await expect(inspectStudioEditSource(db, "w", "p", snapshot)).rejects.toMatchObject({ status: 422 });
  });

  it("verifies real target bytes before loading a clean base and refuses invalid storage ownership", async () => {
    generatedSource({ cleanBase: cleanBase() }); const { snapshot } = await resolve();
    f.get.mockResolvedValueOnce({ body: Readable.from(base), contentLength: base.length });
    await expect(loadStudioEditSource("w", "p", snapshot, deadline())).rejects.toMatchObject({ status: 422 }); expect(f.base).not.toHaveBeenCalled();
    asset.storageKey = "foreign/private"; generated.objectKey = asset.storageKey;
    const foreign = await resolve(); f.get.mockClear();
    await expect(loadStudioEditSource("w", "p", foreign.snapshot, deadline())).rejects.toMatchObject({ status: 422 }); expect(f.get).not.toHaveBeenCalled();
  });

  it("propagates base authentication failures instead of falling back to the composited target", async () => {
    generatedSource({ cleanBase: cleanBase() }); const { snapshot } = await resolve();
    f.base.mockRejectedValueOnce(Object.assign(new Error("wrong key revision"), { status: 503 }));
    await expect(loadStudioEditSource("w", "p", snapshot, deadline())).rejects.toMatchObject({ status: 503 });
  });

  it("locks source assets, project links and uploaded receipt before publication", async () => {
    const { snapshot } = await resolve(); await lockStudioEditPublicationSource(db, "w", "p", snapshot);
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls[0]![0].join(" ")).toContain("FOR SHARE OF a, p");
    expect(f.query.mock.calls[1]![0].join(" ")).toContain("FOR SHARE OF u, t");
    f.query.mockResolvedValueOnce([]); await expect(lockStudioEditPublicationSource(db, "w", "p", snapshot)).rejects.toMatchObject({ status: 422 });
  });

  it("locks generated version, output and request and revalidates changed recipes before publication", async () => {
    generatedSource({ cleanBase: cleanBase() }); const { snapshot } = await resolve();
    await lockStudioEditPublicationSource(db, "w", "p", snapshot);
    expect(f.query.mock.calls[1]![0].join(" ")).toContain("FOR SHARE OF v, g, m, o, r");
    generated.output.params.studioPostprocess.cleanBase.keyRevision = "d".repeat(24);
    await expect(lockStudioEditPublicationSource(db, "w", "p", snapshot)).rejects.toMatchObject({ status: 422 });
  });

  it("rejects cancelled or oversized source reads before returning model input", async () => {
    const { snapshot } = await resolve(), controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(loadStudioEditSource("w", "p", snapshot, controller.signal)).rejects.toThrow("cancelled"); expect(f.get).not.toHaveBeenCalled();
    const body = new Readable({ read() {} }); f.get.mockResolvedValueOnce({ body, contentLength: 33 * 1024 * 1024 });
    await expect(loadStudioEditSource("w", "p", snapshot, deadline())).rejects.toMatchObject({ status: 422 }); expect(body.destroyed).toBe(true);
  });
});

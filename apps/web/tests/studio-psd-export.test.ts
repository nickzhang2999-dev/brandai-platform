import { createHash } from "node:crypto";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ role: vi.fn(), user: vi.fn(), project: vi.fn(), row: vi.fn(), assets: vi.fn(), read: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: { user: { findUnique: f.user }, project: { findFirst: f.project },
  studioDecompositionRequest: { findFirst: f.row }, asset: { findMany: f.assets } } }));
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../src/lib/workspace", () => ({ requireWorkspaceRole: f.role }));
vi.mock("../src/lib/studio-decomposition", () => ({ readStudioLayerAsset: f.read }));
import { exportStudioDecompositionPsd } from "../src/lib/studio-psd-export";
import { ApiException } from "../src/lib/api";
import { readPsdForFileProof } from "../scripts/verify-studio-psd-file";

let layers: any[], request: any, stored: any[], bytes: Buffer[];
const exportFile = (signal = AbortSignal.timeout(4000), workspace = "w", project = "p", id = "request") => exportStudioDecompositionPsd(workspace, "u", project, id, signal);
beforeEach(async () => {
  vi.resetAllMocks();
  bytes = await Promise.all([0, 1].map(async order => {
    const rgba = Buffer.alloc(8 * 8 * 4);
    for (let index = 0; index < 64; index++) if (order === 0 || index > 9 && index < 30) rgba.set([order ? 220 : 40, 50, 180, 255], index * 4);
    return sharp(rgba, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
  }));
  layers = bytes.map((body, order) => ({ order, assetId: `sdl_request_${order}`, width: 8, height: 8, mimeType: "image/png", sizeBytes: body.length,
    assetSha256: createHash("sha256").update(body).digest("hex"), url: `/api/workspaces/w/assets/sdl_request_${order}/raw`,
    alphaBounds: { left: 0, top: 0, width: 8, height: 8 }, inkCoverage: .5 }));
  request = { id: "request", status: "SUCCEEDED", sourceWidth: 8, sourceHeight: 8, publishedLayers: layers };
  stored = layers.map(layer => ({ id: layer.assetId, mimeType: "image/png", sizeBytes: layer.sizeBytes, storageKey: `w/studio-layer-assets/p/request/token/${layer.order}.bin` }));
  f.role.mockResolvedValue({ role: "VIEWER" }); f.user.mockResolvedValue({ isActive: true });
  f.project.mockImplementation(({ where }) => where.workspaceId === "w" && where.id === "p" ? { id: "p" } : null);
  f.row.mockImplementation(({ where }) => where.workspaceId === "w" && where.projectId === "p" && where.id === "request" ? request : null);
  f.assets.mockResolvedValue(stored); f.read.mockImplementation(async (_ws, asset) => bytes[Number(asset.id.slice(-1))]);
});

describe("Studio PSD access boundaries (simulated persistence; real PSD codec; no provider)", () => {
  it("allows a current viewer to download all scoped, published internal layers as a genuine PSD", async () => {
    const output = await exportFile();
    expect(output).toMatchObject({ fileName: "DeepFlare-layers-request.psd", layerCount: 2, width: 8, height: 8 });
    expect(readPsdForFileProof(output.body, { useImageData: true }).children).toHaveLength(2);
    expect(f.role).toHaveBeenCalledWith("w", "u", "VIEWER");
    expect(f.read.mock.calls.map(args => args.slice(0, 2))).toEqual(stored.map(asset => ["w", { id: asset.id, storageKey: asset.storageKey }]));
  });
  it.each([401, 403, 404])("preserves %i access denial before retrieving any layer metadata", async status => {
    f.role.mockRejectedValue(Object.assign(new Error("scope denied"), { status }));
    await expect(exportFile()).rejects.toMatchObject({ status }); expect(f.row).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it("rejects inactive users and a foreign project/request without reading private pixels", async () => {
    f.user.mockResolvedValue({ isActive: false }); await expect(exportFile()).rejects.toMatchObject({ status: 403 });
    f.user.mockResolvedValue({ isActive: true });
    for (const args of [["foreign-w", "p", "request"], ["w", "foreign-p", "request"], ["w", "p", "foreign-request"]]) {
      await expect(exportFile(AbortSignal.timeout(3000), args[0], args[1], args[2])).rejects.toMatchObject({ status: 404 });
    }
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["PENDING", "RUNNING", "FAILED"])("never exports a %s archive, even when a partial layer receipt exists", async status => {
    request.status = status; await expect(exportFile()).rejects.toMatchObject({ status: 409 });
    expect(f.assets).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["single", "duplicate", "wrongWidth", "wrongIdentity", "externalUrl"])("rejects malformed published %s layers without decoding", async scenario => {
    if (scenario === "single") request.publishedLayers = layers.slice(0, 1);
    if (scenario === "duplicate") layers[1].order = 0;
    if (scenario === "wrongWidth") layers[1].width = 7;
    if (scenario === "wrongIdentity") layers[1].assetId = "other_asset";
    if (scenario === "externalUrl") layers[1].url = "https://untrusted.invalid/image.png";
    await expect(exportFile()).rejects.toMatchObject({ status: 422 }); expect(f.read).not.toHaveBeenCalled();
  });
  it.each(["missing", "mime", "size", "key"])("rejects a %s asset rather than producing a partial document", async scenario => {
    if (scenario === "missing") f.assets.mockResolvedValue(stored.slice(0, 1));
    if (scenario === "mime") stored[1].mimeType = "image/jpeg";
    if (scenario === "size") stored[1].sizeBytes++;
    if (scenario === "key") stored[1].storageKey = null;
    await expect(exportFile()).rejects.toMatchObject({ status: 404 }); expect(f.read).not.toHaveBeenCalled();
  });
  it("refuses revoked access after encoding and does not return the prepared private bytes", async () => {
    f.role.mockResolvedValueOnce({ role: "VIEWER" }).mockRejectedValueOnce(new ApiException(404, "membership revoked"));
    await expect(exportFile()).rejects.toMatchObject({ status: 404 }); expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("keeps one memory slot, returns 429 promptly, and releases it after bounded cancellation", async () => {
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    f.read.mockImplementationOnce(async () => { entered(); return new Promise<Buffer>(() => undefined); });
    const controller = new AbortController();
    const first = exportFile(controller.signal); await reading;
    await expect(exportFile()).rejects.toMatchObject({ status: 429 });
    controller.abort(new Error("fixture cancelled")); await expect(first).rejects.toMatchObject({ status: 504 });
    expect((await exportFile()).body.toString("ascii", 0, 4)).toBe("8BPS");
  });
});

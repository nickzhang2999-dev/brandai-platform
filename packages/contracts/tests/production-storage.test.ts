import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ settings: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/settings", () => ({ getEffectiveStorage: f.settings }));
vi.mock("../../../apps/web/node_modules/@aws-sdk/client-s3", () => ({
  S3Client: class { send = f.send; },
  PutObjectCommand: class { constructor(public input: unknown) {} },
  GetObjectCommand: class {}, DeleteObjectCommand: class {},
}));
import { uploadDataUrlImage } from "../../../apps/web/src/lib/s3";
beforeEach(() => { vi.resetAllMocks(); f.settings.mockResolvedValue({ configured: false }); });
afterEach(() => { vi.unstubAllEnvs(); });

it.each(["image/png", "image/svg+xml"])("production rejects missing storage for %s instead of persisting inline", async mime => {
  vi.stubEnv("NODE_ENV", "production");
  await expect(uploadDataUrlImage(`data:${mime};base64,YQ==`, "test")).rejects.toThrow("未配置对象存储");
  expect(f.send).not.toHaveBeenCalled();
});
it("development still supports local demo images without storage", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const url = "data:image/png;base64,YQ==";
  expect(await uploadDataUrlImage(url, "test")).toBe(url);
});
it("production uploads raster content and returns its durable object URL", async () => {
  vi.stubEnv("NODE_ENV", "production");
  f.settings.mockResolvedValue({ configured: true, publicUrl: "https://storage.invalid/", bucket: "test" });
  expect(await uploadDataUrlImage("data:image/png;base64,YQ==", "workspace/version")).toMatch(/^https:\/\/storage.invalid\/workspace\/version\/.+\.png$/);
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.send.mock.calls[0][0].input.Body.toString()).toBe("a");
});
it("upload failures propagate so a worker cannot report successful archival", async () => {
  vi.stubEnv("NODE_ENV", "production");
  f.settings.mockResolvedValue({ configured: true }); f.send.mockRejectedValue(new Error("storage down"));
  await expect(uploadDataUrlImage("data:image/png;base64,YQ==", "test")).rejects.toThrow("storage down");
});

import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ admin: vi.fn(), config: vi.fn(), ai: vi.fn(), send: vi.fn(), destroy: vi.fn(), client: vi.fn() }));
vi.mock("@/lib/api", () => ({
  ok: (value: unknown) => Response.json(value),
  handleError: (error: { status?: number }) => Response.json({ error: "Request failed" }, { status: error.status ?? 500 }),
}));
vi.mock("@/lib/admin", () => ({ requireAdmin: f.admin }));
vi.mock("@/lib/settings", () => ({ getEffectiveStorage: f.config }));
vi.mock("@/lib/ai", () => ({ ai: { diag: f.ai } }));
vi.mock("@/lib/image-preview", async () => import("../../../apps/web/src/lib/image-preview"));
// Resolve from the web package: contracts intentionally has no S3 dependency.
vi.mock("../../../apps/web/node_modules/@aws-sdk/client-s3", () => ({
  S3Client: class { constructor(options: unknown) { f.client(options); } send = f.send; destroy = f.destroy; },
  PutObjectCommand: class { kind = "put"; constructor(public input: Record<string, unknown>) {} },
  GetObjectCommand: class { kind = "get"; constructor(public input: Record<string, unknown>) {} },
  DeleteObjectCommand: class { kind = "delete"; constructor(public input: Record<string, unknown>) {} },
}));
import { POST } from "../../../apps/web/src/app/api/admin/settings/ai/test/route";

const cfg = { configured: true, region: "fixture", endpoint: "https://storage.invalid", bucket: "fixture-bucket",
  forcePathStyle: true, accessKey: "fixture-access", secretKey: "fixture-secret" };
const providers = { image: { ok: false, unverified: true, detail: "unconfigured" }, vlm: { ok: false }, layer: { ok: false } };
let payload: Buffer;
beforeEach(() => {
  vi.resetAllMocks();
  f.admin.mockResolvedValue({ id: "admin" });
  f.config.mockResolvedValue(cfg);
  f.ai.mockResolvedValue(providers);
  f.send.mockImplementation(async (command: { kind: string; input: Record<string, unknown> }) => {
    if (command.kind === "put") { payload = command.input.Body as Buffer; return {}; }
    if (command.kind === "get") return { Body: Readable.from([payload]) };
    return {};
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const result = async () => (await (await POST()).json()) as { storage: { ok: boolean; unverified?: boolean; detail: string } };

describe("admin storage connectivity diagnostics", () => {
  it("does not label an unconfigured store verified and does not create an S3 client", async () => {
    f.config.mockResolvedValue({ ...cfg, configured: false });
    expect((await result()).storage).toMatchObject({ ok: false, unverified: true });
    expect(f.client).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });

  it("authenticates before reading settings or contacting any provider", async () => {
    f.admin.mockRejectedValue({ status: 403 });
    expect((await POST()).status).toBe(403);
    expect(f.config).not.toHaveBeenCalled(); expect(f.ai).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });

  it("only succeeds after writing, reading matching bytes and deleting the same unique object", async () => {
    const response = await (await POST()).json();
    expect(response.storage.ok).toBe(true);
    expect(response.image).toEqual(providers.image); expect(response.vlm).toEqual(providers.vlm); expect(response.layer).toEqual(providers.layer);
    expect(f.send.mock.calls.map(([command]) => command.kind)).toEqual(["put", "get", "delete"]);
    const keys = f.send.mock.calls.map(([command]) => command.input.Key);
    expect(keys.every(key => key === keys[0])).toBe(true); expect(keys[0]).toMatch(/^__ov_diag\/[0-9a-f-]+\.txt$/);
    expect(f.send.mock.calls.every(([, options]) => options.abortSignal instanceof AbortSignal)).toBe(true);
    expect(f.send.mock.calls[2][1].abortSignal).not.toBe(f.send.mock.calls[0][1].abortSignal);
    expect(f.client).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 1 })); expect(f.destroy).toHaveBeenCalledOnce();
    await result(); expect(f.send.mock.calls[3][0].input.Key).not.toBe(keys[0]);
  });

  it("reads and deletes the exact returned object version in versioned stores", async () => {
    f.send.mockImplementation(async command => {
      if (command.kind === "put") { payload = command.input.Body; return { VersionId: "written-version" }; }
      if (command.kind === "get") return { Body: Readable.from([payload]) };
      return {};
    });
    expect((await result()).storage.ok).toBe(true);
    for (const [command] of f.send.mock.calls.slice(1)) expect(command.input.VersionId).toBe("written-version");
  });

  it.each(["missing", "different", "oversized"])("rejects %s object contents and still cleans up", async mode => {
    f.send.mockImplementation(async command => {
      if (command.kind === "put") { payload = command.input.Body; return {}; }
      if (command.kind === "get") return mode === "missing" ? {} : { Body: Readable.from([mode === "different" ? Buffer.from("wrong") : Buffer.alloc(4096)]) };
      return {};
    });
    expect((await result()).storage.ok).toBe(false);
    expect(f.send.mock.calls.at(-1)?.[0].kind).toBe("delete"); expect(f.destroy).toHaveBeenCalledOnce();
  });

  it("attempts cleanup after an unacknowledged PUT and does not disclose raw upstream errors", async () => {
    f.send.mockImplementation(async command => {
      if (command.kind === "put") throw new Error(`${cfg.endpoint} ${cfg.secretKey} ${cfg.accessKey}`);
      return {};
    });
    const check = (await result()).storage;
    expect(check.ok).toBe(false); expect(check.detail).toContain("写入失败");
    for (const secret of [cfg.endpoint, cfg.secretKey, cfg.accessKey, cfg.bucket]) expect(check.detail).not.toContain(secret);
    expect(f.send.mock.calls.map(([command]) => command.kind)).toEqual(["put", "delete"]);
  });

  it("reports cleanup failure even when the bytes matched", async () => {
    f.send.mockImplementation(async command => {
      if (command.kind === "put") { payload = command.input.Body; return {}; }
      if (command.kind === "get") return { Body: Readable.from([payload]) };
      throw Object.assign(new Error("private upstream detail"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    });
    const check = (await result()).storage;
    expect(check.ok).toBe(false); expect(check.detail).toContain("清理失败"); expect(check.detail).toContain("HTTP 403");
    expect(check.detail).not.toContain("private upstream detail"); expect(f.destroy).toHaveBeenCalledOnce();
  });

  it("preserves both read and cleanup failures", async () => {
    f.send.mockImplementation(async command => {
      if (command.kind === "put") return {};
      throw new Error("unavailable");
    });
    const check = (await result()).storage;
    expect(check.ok).toBe(false); expect(check.detail).toContain("读取失败"); expect(check.detail).toContain("清理失败");
  });

  it("bounds a stalled read and gives cleanup a fresh deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    f.send.mockImplementation(async command => {
      if (command.kind === "get") return { Body: new Readable({ read() {} }) };
      return {};
    });
    const pending = result();
    await vi.advanceTimersByTimeAsync(8_000);
    const check = (await pending).storage;
    expect(check.ok).toBe(false); expect(check.detail).toContain("超时");
    expect(f.send.mock.calls[2][1].abortSignal.aborted).toBe(false); expect(f.destroy).toHaveBeenCalledOnce();
  });

  it("bounds a stalled cleanup and marks the residual-object risk", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), ms);
      return controller.signal;
    });
    f.send.mockImplementation(async (command, { abortSignal }) => {
      if (command.kind === "put") { payload = command.input.Body; return {}; }
      if (command.kind === "get") return { Body: Readable.from([payload]) };
      return new Promise((_, reject) => abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true }));
    });
    const pending = result(); await vi.advanceTimersByTimeAsync(4_000);
    const check = (await pending).storage;
    expect(check.ok).toBe(false); expect(check.detail).toContain("清理失败"); expect(check.detail).toContain("__ov_diag/");
    expect(f.destroy).toHaveBeenCalledOnce();
  });
});

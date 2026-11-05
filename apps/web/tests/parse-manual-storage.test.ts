import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ parse: vi.fn(), upload: vi.fn(), asset: vi.fn(), rule: vi.fn(), permit: vi.fn(), succeed: vi.fn() }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: {}, Prisma: {} }));
vi.mock("@/lib/queue", () => ({ connection: {}, queuePrefix: "synthetic-manual-storage" }));
vi.mock("@/lib/ai", () => ({ ai: { parseManual: f.parse } }));
vi.mock("@/lib/usage", () => ({ recordUsage: vi.fn() }));
vi.mock("@/lib/async-tasks", () => ({ setProgress: vi.fn() }));
vi.mock("@/lib/s3", () => ({ uploadBuffer: f.upload }));
vi.mock("@/lib/assets", () => ({ decodeImageResolution: () => undefined }));
vi.mock("@/lib/brand-kit-permissions", () => ({ requireBrandKitTaskPermission: f.permit }));
vi.mock("@/lib/legacy-task-runtime", () => ({ runLegacyTask: async (_input: unknown, work: any) => work({
  signal: new AbortController().signal, check() {}, succeed: f.succeed,
  write: (fn: any) => fn({ asset: { create: f.asset }, brandRule: { create: f.rule } }),
}) }));

import { runParseManualJob } from "@/lib/workers/parse-manual.worker";

const job = () => ({ id: "queue-task", data: { taskId: "task", workspaceId: "brand", assetId: "manual", url: "https://synthetic.invalid/manual.pdf" }, updateProgress: vi.fn() }) as any;
beforeEach(() => {
  vi.resetAllMocks();
  f.parse.mockResolvedValue({ rules: [{ type: "logo", strength: "WEAK", summary: "Logo evidence", value: {},
    evidence: [{ sourceRef: "logo-ref", page: 2 }] }], warnings: [],
    extractedAssets: [{ ref: "logo-ref", type: "logo", page: 2, label: "Synthetic crop", dataUrl: "data:image/png;base64,aGVsbG8=" }],
  });
  f.upload.mockResolvedValue({ key: "brand/brand-kit/random-upload.png", url: "https://synthetic.invalid/deployments/test/brand/brand-kit/random-upload.png" });
  f.asset.mockResolvedValue({ id: "crop" }); f.rule.mockResolvedValue({ id: "rule" });
});

describe("manual crop storage identity", () => {
  it("persists the key and URL from the same completed upload and cites the created crop", async () => {
    const result = await runParseManualJob(job());
    expect(f.upload).toHaveBeenCalledWith(Buffer.from("hello"), "image/png", "brand/brand-kit", expect.any(AbortSignal));
    expect(f.asset).toHaveBeenCalledWith({ data: expect.objectContaining({ workspaceId: "brand", storageKey: "brand/brand-kit/random-upload.png",
      url: "https://synthetic.invalid/deployments/test/brand/brand-kit/random-upload.png", mimeType: "image/png", sizeBytes: 5 }) });
    expect(f.upload.mock.invocationCallOrder[0]).toBeLessThan(f.asset.mock.invocationCallOrder[0]!);
    expect(f.rule.mock.calls[0]?.[0].data.evidence).toEqual([{ assetId: "crop", page: 2, note: "品牌手册第 2 页" }]);
    expect(result.assetIds).toEqual(["crop"]);
  });
  it("does not create a dangling asset or rule when object upload fails", async () => {
    f.upload.mockRejectedValue(new Error("synthetic object write failure"));
    await expect(runParseManualJob(job())).rejects.toThrow("synthetic object write failure");
    expect(f.asset).not.toHaveBeenCalled(); expect(f.rule).not.toHaveBeenCalled(); expect(f.succeed).not.toHaveBeenCalled();
  });
  it("revalidates source permission after upload before persisting a derived image", async () => {
    f.permit.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("source revoked"));
    await expect(runParseManualJob(job())).rejects.toThrow("source revoked");
    expect(f.upload).toHaveBeenCalledOnce(); expect(f.asset).not.toHaveBeenCalled(); expect(f.rule).not.toHaveBeenCalled();
  });
});

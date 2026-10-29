import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi } from "vitest";
const f = vi.hoisted(() => ({ recognize: vi.fn(), parseManual: vi.fn(), upload: vi.fn(), usage: vi.fn() }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/lib/queue", () => ({ connection: {}, queuePrefix: "synthetic-brand-kit" }));
vi.mock("@/lib/ai", () => ({ ai: { recognize: f.recognize, parseManual: f.parseManual } }));
vi.mock("@/lib/usage", () => ({ recordUsage: f.usage }));
vi.mock("@/lib/s3", () => ({ uploadDataUrlImage: f.upload }));
vi.mock("@/lib/assets", () => ({ decodeImageResolution: () => undefined }));
import { prisma } from "@brandai/db";
import { brandKitImportTask, readBrandKitImportTask } from "@/lib/brand-kit-import";
import { runRecognizeJob } from "@/lib/workers/recognize.worker";
import { runParseManualJob } from "@/lib/workers/parse-manual.worker";

const isolated = process.env.WRITING_TEST_DATABASE_URL;
const suite = isolated ? describe : describe.skip;
suite("Brand Kit real PostgreSQL receipts and worker persistence with synthetic providers", () => {
  let workspaceId: string, userId: string, sourceId: string, manualId: string;
  beforeAll(() => {
    const url = new URL(isolated!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/nova_writing_test" || process.env.DATABASE_URL !== isolated) throw new Error("Explicit isolated database required");
  });
  beforeEach(async () => {
    vi.resetAllMocks(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("No external network permitted"); }));
    const prefix = "brand-kit-test-" + randomUUID(); workspaceId = prefix + "-w"; userId = prefix + "-u"; sourceId = prefix + "-source"; manualId = prefix + "-manual";
    await prisma.user.create({ data: { id: userId, email: userId + "@example.invalid", isActive: true } });
    await prisma.brandWorkspace.create({ data: { id: workspaceId, ownerId: userId, name: "合成品牌套件" } });
    await prisma.asset.createMany({ data: [sourceId, manualId].map(id => ({ id, workspaceId, category: id === manualId ? "VI_DOC" : "LOGO", libraryKind: "BRAND_KIT", fileName: "synthetic", url: "https://synthetic.invalid/" + id, storageKey: id, mimeType: id === manualId ? "application/pdf" : "image/png", sizeBytes: 1, source: "UPLOAD", availableForGeneration: true })) });
    f.upload.mockResolvedValue("https://synthetic.invalid/crop.png");
  });
  afterEach(async () => {
    await prisma.asyncTask.deleteMany({ where: { workspaceId } });
    await prisma.user.delete({ where: { id: userId } });
    vi.unstubAllGlobals();
  });
  afterAll(async () => { await prisma.$disconnect(); });
  const request = () => ({ mutationId: randomUUID(), assetIds: [sourceId], targetType: "logo" });
  const rule = (summary: string, type = "layout") => ({ type, strength: "WEAK", summary, value: { grid: "fixture" }, evidence: [{ assetId: sourceId, note: "合成证据" }] });
  const job = (taskId: string, extra: Record<string, unknown> = {}) => ({ id: taskId, data: { taskId, workspaceId,
    assets: [{ id: sourceId, url: "https://synthetic.invalid/a.png", source: "UPLOAD" }], targetType: "logo", ...extra }, updateProgress: vi.fn() } as any);

  it("concurrent retries create one receipt, reject changed payload, isolate receipt lookups", async () => {
    const input = request();
    const receipts = await Promise.all(Array.from({ length: 4 }, () => brandKitImportTask(workspaceId, userId, "RECOGNIZE", input.mutationId, input)));
    expect(new Set(receipts.map(row => row.id)).size).toBe(1);
    expect(await prisma.asyncTask.count({ where: { workspaceId } })).toBe(1);
    expect((await readBrandKitImportTask(workspaceId, userId, "RECOGNIZE", input.mutationId)).taskId).toBe(receipts[0]!.id);
    await expect(brandKitImportTask(workspaceId, userId, "RECOGNIZE", input.mutationId, { ...input, targetType: "layout" })).rejects.toMatchObject({ status: 409 });
    await expect(readBrandKitImportTask(workspaceId, "other-user", "RECOGNIZE", input.mutationId)).rejects.toMatchObject({ status: 404 });
    await expect(readBrandKitImportTask("other-workspace", userId, "RECOGNIZE", input.mutationId)).rejects.toMatchObject({ status: 404 });
    await expect(readBrandKitImportTask(workspaceId, userId, "PARSE_MANUAL", input.mutationId)).rejects.toMatchObject({ status: 404 });
    expect(f.recognize).not.toHaveBeenCalled();
  });
  it("actual recognize worker keeps two suggestions as draft Logo rules and pays once on replay", async () => {
    const input = request(), task = await brandKitImportTask(workspaceId, userId, "RECOGNIZE", input.mutationId, input);
    f.recognize.mockResolvedValue({ rules: [rule("第一条建议"), rule("第二条建议", "copy")] });
    const result = await runRecognizeJob(job(task.id));
    expect(result.ruleIds).toHaveLength(2);
    const rows = await prisma.brandRule.findMany({ where: { workspaceId } });
    expect(rows).toHaveLength(2); expect(rows.every(row => row.type === "logo" && row.status === "DRAFT")).toBe(true);
    expect(rows.map(row => row.summary).sort()).toEqual(["第一条建议", "第二条建议"].sort());
    expect(rows[0]?.value).toHaveProperty("analysisSuggestion");
    expect(f.recognize.mock.calls[0]?.[0]).toMatchObject({ targetType: "logo" });
    await expect(runRecognizeJob(job(task.id))).rejects.toThrow("不会重复调用模型");
    expect(f.recognize).toHaveBeenCalledOnce(); expect(await prisma.brandRule.count({ where: { workspaceId } })).toBe(2);
    expect((await brandKitImportTask(workspaceId, userId, "RECOGNIZE", input.mutationId, input)).status).toBe("SUCCEEDED");
  });
  it("legacy omitted targetType preserves model classes and does not inject wire intent", async () => {
    const input = request(), task = await brandKitImportTask(workspaceId, userId, "RECOGNIZE", input.mutationId, input);
    f.recognize.mockResolvedValue({ rules: [rule("旧模式设计指南")] });
    await runRecognizeJob(job(task.id, { targetType: undefined }));
    expect(f.recognize.mock.calls[0]?.[0]).not.toHaveProperty("targetType");
    expect((await prisma.brandRule.findFirst({ where: { workspaceId } }))?.type).toBe("layout");
  });
  it("a provider failure remains failed under receipt and worker replay, without new rules", async () => {
    const input = request(), task = await brandKitImportTask(workspaceId, userId, "RECOGNIZE", input.mutationId, input);
    f.recognize.mockRejectedValue(new Error("synthetic unavailable"));
    await expect(runRecognizeJob(job(task.id))).rejects.toThrow("synthetic unavailable");
    expect((await brandKitImportTask(workspaceId, userId, "RECOGNIZE", input.mutationId, input)).status).toBe("FAILED");
    await expect(runRecognizeJob(job(task.id))).rejects.toThrow("不会重复调用模型");
    expect(f.recognize).toHaveBeenCalledOnce(); expect(await prisma.brandRule.count({ where: { workspaceId } })).toBe(0);
  });
  it("a queued Brand Kit source revoked before execution never reaches the provider", async () => {
    const input = request(), task = await brandKitImportTask(workspaceId, userId, "RECOGNIZE", input.mutationId, input);
    await prisma.asset.update({ where: { id: sourceId }, data: { availableForGeneration: false } });
    await expect(runRecognizeJob(job(task.id))).rejects.toThrow();
    expect(f.recognize).not.toHaveBeenCalled(); expect(await prisma.brandRule.count({ where: { workspaceId } })).toBe(0);
  });
  it("a source revoked during the paid call cannot land output rules", async () => {
    const input = request(), task = await brandKitImportTask(workspaceId, userId, "RECOGNIZE", input.mutationId, input);
    f.recognize.mockImplementation(async () => { await prisma.asset.update({ where: { id: sourceId }, data: { deprecatedAt: new Date() } }); return { rules: [rule("late suggestion")] }; });
    await expect(runRecognizeJob(job(task.id))).rejects.toThrow();
    expect(f.recognize).toHaveBeenCalledOnce(); expect(await prisma.brandRule.count({ where: { workspaceId } })).toBe(0);
    expect(f.usage).toHaveBeenCalledOnce(); expect(f.usage).toHaveBeenCalledWith(expect.objectContaining({ status: "SUCCEEDED", kind: "RECOGNIZE", workspaceId }));
    expect((await prisma.asyncTask.findUnique({ where: { id: task.id } }))?.status).toBe("FAILED");
  });
  it("manual revoked during crop upload does not persist derived assets or rules", async () => {
    const mutationId = randomUUID(), task = await brandKitImportTask(workspaceId, userId, "PARSE_MANUAL", mutationId, { assetId: manualId, mutationId });
    f.parseManual.mockResolvedValue({ rules: [rule("late manual", "logo")], extractedAssets: [{ ref: "crop", type: "logo", page: 1, label: "test", dataUrl: "data:image/png;base64,aGVsbG8=" }], warnings: [] });
    f.upload.mockImplementation(async () => { await prisma.asset.update({ where: { id: manualId }, data: { availableForGeneration: false } }); return "https://synthetic.invalid/crop.png"; });
    await expect(runParseManualJob(job(task.id, { assetId: manualId, url: "https://synthetic.invalid/manual.pdf" }))).rejects.toThrow();
    expect(f.parseManual).toHaveBeenCalledOnce(); expect(f.upload).toHaveBeenCalledOnce();
    expect(f.usage).toHaveBeenCalledOnce(); expect(f.usage).toHaveBeenCalledWith(expect.objectContaining({ status: "SUCCEEDED", kind: "PARSE_MANUAL", workspaceId }));
    expect(await prisma.asset.count({ where: { workspaceId } })).toBe(2); expect(await prisma.brandRule.count({ where: { workspaceId } })).toBe(0);
  });
  it("manual selected category preserves original crop/source page and retains every suggestion", async () => {
    const mutationId = randomUUID(), task = await brandKitImportTask(workspaceId, userId, "PARSE_MANUAL", mutationId, { assetId: manualId, mutationId, targetType: "layout" });
    f.parseManual.mockResolvedValue({ rules: [
      { ...rule("图形规范", "logo"), evidence: [{ page: 2, sourceRef: "crop-logo", note: "原图" }] },
      { ...rule("附加建议", "logo"), evidence: [] }], warnings: [], extractedAssets: [
      { ref: "crop-logo", type: "logo", page: 2, label: "合成截取", dataUrl: "data:image/png;base64,aGVsbG8=" }] });
    const result = await runParseManualJob(job(task.id, { assetId: manualId, url: "https://synthetic.invalid/manual.pdf", targetType: "layout" }));
    expect(result.ruleIds).toHaveLength(2); expect(result.assetIds).toHaveLength(1);
    const rows = await prisma.brandRule.findMany({ where: { workspaceId } });
    expect(rows.every(row => row.type === "layout" && row.status === "DRAFT")).toBe(true);
    expect((rows.find(row => row.summary === "图形规范")?.evidence as any[])[0]).toMatchObject({ assetId: result.assetIds[0], page: 2 });
    expect((rows.find(row => row.summary === "附加建议")?.evidence as any[])[0]).toMatchObject({ assetId: result.assetIds[0] });
    expect(f.parseManual.mock.calls[0]?.[0]).toMatchObject({ targetType: "layout" });
    await expect(runParseManualJob(job(task.id))).rejects.toThrow("不会重复调用模型"); expect(f.parseManual).toHaveBeenCalledOnce();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ create: vi.fn(), expire: vi.fn(), pending: vi.fn(), enqueue: vi.fn(), user: vi.fn(), role: vi.fn(), project: vi.fn(), generation: vi.fn(), version: vi.fn(), studio: vi.fn() }));
vi.mock("../../db/src/index", () => ({ Prisma: {}, prisma: {
  asyncTask: { create: f.create, updateMany: f.expire, findMany: f.pending }, user: { findUnique: f.user }, project: { findFirst: f.project },
  generation: { findUnique: f.generation }, generationVersion: { findUnique: f.version }, studioGenerationRequest: { findUnique: f.studio },
} }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("../../../apps/web/src/lib/workspace", () => ({ requireWorkspaceRole: f.role }));
vi.mock("../../../apps/web/src/lib/compliance-task-queue", () => ({ enqueueComplianceTask: f.enqueue }));
import { ApiException } from "../../../apps/web/src/lib/api";
import { createComplianceTask, dispatchComplianceTasks, validateComplianceTaskSource, COMPLIANCE_TASK_TTL_MS, COMPLIANCE_TASK_KINDS } from "../../../apps/web/src/lib/compliance-tasks";
const input = { userId: "u", projectId: "p", generationId: "g", versionId: "v", imageUrl: "https://test/image.png", text: "brief。scene" };
beforeEach(() => {
  vi.resetAllMocks(); f.create.mockImplementation(async ({ data }) => ({ id: "t", ...data })); f.enqueue.mockResolvedValue(false);
  f.pending.mockResolvedValue([]); f.user.mockResolvedValue({ isActive: true }); f.project.mockResolvedValue({ id: "p" });
  f.generation.mockResolvedValue({ id: "g", projectId: "p", workspaceId: "w", sellingPoint: "brief", scene: "scene" });
  f.version.mockResolvedValue({ id: "v", generationId: "g", imageUrl: input.imageUrl }); f.studio.mockResolvedValue(null);
});
describe("durable compliance outbox", () => {
  it("persists a bounded immutable request before enqueue; Redis failure retains receipt", async () => {
    const start = Date.now(); await expect(createComplianceTask("w", "COMPLIANCE_RECHECK", input)).resolves.toEqual({ taskId: "t", status: "PENDING" });
    const data = f.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ workspaceId: "w", kind: "COMPLIANCE_RECHECK", inputJson: input, refId: "v", status: "PENDING", progress: 0 });
    expect(data.jobId).toMatch(/^check_[a-f0-9]{32}$/); expect(data.expiresAt.getTime()).toBeGreaterThanOrEqual(start + COMPLIANCE_TASK_TTL_MS);
    expect(f.create.mock.invocationCallOrder[0]).toBeLessThan(f.enqueue.mock.invocationCallOrder[0]);
    expect(f.enqueue).toHaveBeenCalledWith("t", data.jobId);
  });
  it("rejects malformed inputs before accepting durable work", async () => {
    await expect(createComplianceTask("w", "COMPLIANCE_PRECHECK", { userId: "", text: "x" })).rejects.toThrow(); expect(f.create).not.toHaveBeenCalled();
  });
  it("expires only compliance tasks and dispatches bounded pending work", async () => {
    f.pending.mockResolvedValue([{ id: "t", jobId: "j" }, { id: "empty", jobId: null }]); await dispatchComplianceTasks();
    expect(f.expire).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ kind: { in: [...COMPLIANCE_TASK_KINDS] }, status: { in: ["PENDING", "RUNNING"] } }), data: expect.objectContaining({ status: "FAILED" }) }));
    expect(f.pending).toHaveBeenCalledWith(expect.objectContaining({ take: 50, where: expect.objectContaining({ status: "PENDING" }) }));
    expect(f.enqueue).toHaveBeenCalledTimes(1); expect(f.enqueue).toHaveBeenCalledWith("t", "j");
  });
});
describe("queued source revalidation", () => {
  it("requires active identity, editor role and current source ownership", async () => {
    await validateComplianceTaskSource("w", "COMPLIANCE_RECHECK", input);
    expect(f.role).toHaveBeenCalledWith("w", "u", "EDITOR"); expect(f.project).toHaveBeenCalledWith({ where: { id: "p", workspaceId: "w" }, select: { id: true } });
  });
  it("blocks accounts disabled during the queue wait", async () => {
    f.user.mockResolvedValue({ isActive: false }); await expect(validateComplianceTaskSource("w", "COMPLIANCE_RECHECK", input)).rejects.toMatchObject({ status: 403 }); expect(f.version).not.toHaveBeenCalled();
  });
  it("blocks a revoked editor before reading the source", async () => {
    f.role.mockRejectedValue(new ApiException(403, "revoked")); await expect(validateComplianceTaskSource("w", "COMPLIANCE_RECHECK", input)).rejects.toMatchObject({ status: 403 }); expect(f.version).not.toHaveBeenCalled();
  });
  it("blocks a moved/deleted project", async () => {
    f.project.mockResolvedValue(null); await expect(validateComplianceTaskSource("w", "GENERATION_PRECHECK", input)).rejects.toMatchObject({ status: 404 });
  });
  it.each([
    { generation: { workspaceId: "other" } }, { generation: { sellingPoint: "changed" } }, { generation: { projectId: "other" } },
    { version: { generationId: "other" } }, { version: { imageUrl: "https://test/changed.png" } },
  ])("blocks stale or foreign recheck source %j", async change => {
    if (change.generation) f.generation.mockResolvedValue({ id: "g", projectId: "p", workspaceId: "w", sellingPoint: "brief", scene: "scene", ...change.generation });
    if (change.version) f.version.mockResolvedValue({ id: "v", generationId: "g", imageUrl: input.imageUrl, ...change.version });
    await expect(validateComplianceTaskSource("w", "COMPLIANCE_RECHECK", input)).rejects.toMatchObject({ status: 409 });
  });
  it("keeps product/Studio generations out of the legacy recheck path", async () => {
    f.studio.mockResolvedValue({ id: "studio" }); await expect(validateComplianceTaskSource("w", "COMPLIANCE_RECHECK", input)).rejects.toMatchObject({ status: 409 });
  });
  it("requires a project reference for a generation brief check", async () => {
    await expect(validateComplianceTaskSource("w", "GENERATION_PRECHECK", { userId: "u", text: "x" })).rejects.toMatchObject({ status: 422 });
  });
});

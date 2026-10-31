import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
const f = vi.hoisted(() => ({ scope: vi.fn(), freeze: vi.fn(), assertSources: vi.fn(), task: vi.fn(), create: vi.fn(), update: vi.fn(), message: vi.fn(), receipt: null as unknown }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/lib/studio-materials", () => ({ requireStudioMaterialProject: f.scope }));
vi.mock("@/lib/studio-generation-artifacts", () => ({ requireArtifactWrite: vi.fn() }));
vi.mock("@/lib/studio-project-context", () => ({ freezeStudioProjectContext: f.freeze, assertStudioProjectContextSources: f.assertSources }));
vi.mock("@/lib/studio-copywriting-provider", () => ({ copywritingEnabled: () => true }));
vi.mock("@/lib/usage", () => ({ recordUsage: vi.fn() }));
vi.mock("@brandai/db", () => {
  const db = {
    $executeRaw: vi.fn(), $queryRaw: vi.fn(async () => [{ id: "ws" }]), user: { findUnique: vi.fn(async () => ({ isActive: true })) },
    brandWorkspace: { findUniqueOrThrow: vi.fn(async () => ({ name: "合成品牌" })) },
    project: { findFirstOrThrow: vi.fn(async () => ({ name: "合成项目" })) },
    asyncTask: { findUnique: f.task, create: f.create, count: vi.fn(async () => 0), updateMany: f.update },
    studioWritingDocument: { upsert: vi.fn(async () => ({ id: "doc", revision: 0, title: "稿件", text: "当前稿" })), findFirst: vi.fn(async () => ({ id: "doc", revision: 0 })) },
    studioWritingReference: { findMany: vi.fn(async () => []) },
    studioWritingMessage: { findMany: vi.fn(async () => []), create: f.message },
  };
  return { prisma: { ...db, $transaction: (work: (tx: typeof db) => Promise<unknown>) => work(db) } };
});
import { submitWriting, type WritingInput } from "@/lib/studio-writing";
import { processWritingTask } from "@/lib/studio-writing-runtime";
const scope = { workspaceId: "ws", projectId: "project", userId: "user" };
const snapshot = { projectId: "project", revision: 2, facts: { goal: "发布新品", audience: "设计师", approvedCopy: "已确认文案", visualRequirements: "简洁" }, materials: [], master: null, updatedAt: null };
const request = () => ({ mutationId: randomUUID(), expectedRevision: 0, mode: "GENERATE", prompt: "本轮写得更短", referenceIds: [], styleRevision: null });
const result = { text: "模型建议", scope: "DOCUMENT", baseRevision: 0, citations: [], styleDraft: null, model: "synthetic-only", inputTokens: 1, outputTokens: 1, latencyMs: 1 };
beforeEach(() => {
  vi.clearAllMocks(); f.receipt = null;
  f.scope.mockReset().mockResolvedValue(undefined);
  f.freeze.mockResolvedValue(snapshot); f.assertSources.mockResolvedValue(undefined);
  f.task.mockImplementation(async () => f.receipt);
  f.create.mockImplementation(async ({ data }) => (f.receipt = { ...data, createdAt: new Date(), status: "PENDING", progress: 0, resultJson: null, error: null }));
  f.update.mockResolvedValue({ count: 1 });
});
describe("writing uses explicitly confirmed, immutable project context", () => {
  it("freezes once and replays the original receipt even when the project was edited later", async () => {
    const input = { ...request(), projectContextRevision: 2 };
    const first = await submitWriting(scope, input);
    const stored = f.create.mock.calls[0][0].data.inputJson as WritingInput;
    expect(stored.context?.projectContext).toEqual(snapshot);
    expect(f.freeze.mock.calls[0].slice(1)).toEqual(["ws", "project", 2]);
    f.freeze.mockRejectedValue(new Error("new revision must not replace the accepted snapshot"));
    expect(await submitWriting(scope, input)).toEqual(first); expect(f.freeze).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it("rejects a stale confirmed revision before accepting a task", async () => {
    f.freeze.mockRejectedValue(Object.assign(new Error("项目资料已更新"), { status: 409 }));
    await expect(submitWriting(scope, { ...request(), projectContextRevision: 1 })).rejects.toMatchObject({ status: 409 });
    expect(f.create).not.toHaveBeenCalled(); expect(f.message).not.toHaveBeenCalled();
  });
  it("leaves old requests unchanged and never silently injects saved project information", async () => {
    await submitWriting(scope, request());
    expect(f.freeze).not.toHaveBeenCalled();
    expect(f.create.mock.calls[0][0].data.inputJson.context).not.toHaveProperty("projectContext");
  });
  it("checks frozen sources before the model and prevents a call if access was revoked", async () => {
    const task = await submitWriting(scope, { ...request(), projectContextRevision: 2 });
    f.assertSources.mockRejectedValue(Object.assign(new Error("项目素材已不可用"), { status: 409 }));
    const generate = vi.fn(async () => result);
    await processWritingTask(task.id, { generate: generate as never });
    expect(generate).not.toHaveBeenCalled();
    expect(f.update.mock.calls.some(([arg]) => arg.data.status === "FAILED")).toBe(true);
    expect(f.update.mock.calls.some(([arg]) => arg.data.status === "SUCCEEDED")).toBe(false);
  });
  it("retains the accepted facts and revalidates sources after the model before saving", async () => {
    const task = await submitWriting(scope, { ...request(), projectContextRevision: 2 });
    const generate = vi.fn(async (context) => { expect(context.input.context.projectContext).toEqual(snapshot); return result; });
    f.assertSources.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error("生成期间素材权限已撤销"), { status: 409 }));
    await processWritingTask(task.id, { generate: generate as never });
    expect(generate).toHaveBeenCalledTimes(1); expect(f.assertSources).toHaveBeenCalledTimes(2);
    expect(f.assertSources.mock.calls[1][4]).toBe(true);
    expect(f.update.mock.calls.some(([arg]) => arg.data.status === "SUCCEEDED")).toBe(false);
    expect(f.update.mock.calls.some(([arg]) => arg.data.status === "FAILED")).toBe(true);
  });
  it("does not send a draft or project facts when membership is revoked while preparing references", async () => {
    const task = await submitWriting(scope, { ...request(), projectContextRevision: 2 });
    f.scope.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Object.assign(new Error("编辑权限已撤销"), { status: 403 }));
    const generate = vi.fn(async () => result);
    await processWritingTask(task.id, { generate: generate as never });
    expect(generate).not.toHaveBeenCalled();
    expect(f.update.mock.calls.some(([arg]) => arg.data.status === "FAILED")).toBe(true);
  });
});

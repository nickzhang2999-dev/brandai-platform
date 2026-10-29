import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ user: vi.fn(), role: vi.fn(), own: vi.fn(), assets: vi.fn(), asset: vi.fn(), upsert: vi.fn(), update: vi.fn(), find: vi.fn(),
  add: vi.fn(), oldTask: vi.fn(), ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: { asset: { findMany: f.assets, findFirst: f.asset }, asyncTask: { upsert: f.upsert, update: f.update, findFirst: f.find } } }));
vi.mock("@/lib/api", () => ({ ApiException: f.ApiException, requireUser: f.user, parse: (schema: any, input: unknown) => schema.parse(input),
  ok: (body: unknown, init?: ResponseInit) => Response.json(body, init), handleError: (error: any) => Response.json({ error: error.message }, { status: error.status ?? (error.name === "ZodError" ? 400 : 500) }) }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceRole: f.role, requireOwnedWorkspace: f.own }));
vi.mock("@/lib/queue", () => ({ recognizeQueue: { add: f.add }, parseManualQueue: { add: f.add } }));
vi.mock("@/lib/async-tasks", () => ({ createTask: f.oldTask }));
import { POST as recognize, GET as recognizeReceipt } from "../src/app/api/workspaces/[wsId]/rules/recognize/route";
import { POST as manual } from "../src/app/api/workspaces/[wsId]/rules/parse-manual/route";

const params = Promise.resolve({ wsId: "workspace" }), mutationId = "e4e4c9c8-a2e7-4ea8-b85b-99463a11fc51";
const req = (input: unknown) => new Request("http://127.0.0.1/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
let rows: Map<string, any>;
beforeEach(() => {
  vi.resetAllMocks(); rows = new Map(); f.user.mockResolvedValue({ id: "owner" }); f.role.mockResolvedValue({}); f.own.mockResolvedValue({});
  f.assets.mockResolvedValue([{ id: "asset", url: "https://synthetic.invalid/a", source: "UPLOAD" }]);
  f.asset.mockResolvedValue({ id: "manual", url: "https://synthetic.invalid/manual" }); f.oldTask.mockResolvedValue({ id: "legacy-task" });
  f.upsert.mockImplementation(({ where, create }) => { if (!rows.has(where.id)) rows.set(where.id, { ...create, status: "PENDING", jobId: null }); return structuredClone(rows.get(where.id)); });
  f.add.mockImplementation((_name, _data, options) => ({ id: options.jobId ?? "legacy-job" }));
  f.update.mockImplementation(({ where, data }) => { Object.assign(rows.get(where.id) ?? {}, data); return {}; });
});
describe("Brand Kit intake routes retain old calls and explicit retry identity", () => {
  it.each([[recognize, { assetIds: ["asset"] }], [manual, { assetId: "manual" }]] as const)("omitted mutation and type keep legacy intake behavior", async (post, body) => {
    expect((await post(req(body), { params })).status).toBe(202); expect(f.oldTask).toHaveBeenCalledOnce(); expect(f.upsert).not.toHaveBeenCalled();
    expect(f.add.mock.calls[0]?.[1]).not.toHaveProperty("targetType"); expect(f.add.mock.calls[0]?.[2]).not.toHaveProperty("jobId");
  });
  it.each([[recognize, { assetIds: ["asset"] }], [manual, { assetId: "manual" }]] as const)("queues selected classification and safely replays a lost enqueue response", async (post, body) => {
    const input = { ...body, mutationId, targetType: "logo" };
    f.add.mockRejectedValueOnce(new Error("synthetic lost queue receipt"));
    expect((await post(req(input), { params })).status).toBe(500);
    const response = await post(req(input), { params }); expect(response.status).toBe(202);
    expect(rows.size).toBe(1); expect(f.oldTask).not.toHaveBeenCalled();
    expect(f.add.mock.calls[0]?.[2].jobId).toBe(f.add.mock.calls[1]?.[2].jobId);
    expect(f.add.mock.calls[1]?.[1]).toMatchObject({ targetType: "logo", workspaceId: "workspace" });
    const receipt = await response.json(); rows.get(receipt.taskId).status = "SUCCEEDED"; f.add.mockClear();
    expect((await post(req(input), { params })).status).toBe(202); expect(f.add).not.toHaveBeenCalled();
    expect((await post(req({ ...input, targetType: "layout" }), { params })).status).toBe(409); expect(f.add).not.toHaveBeenCalled();
  });
  it.each(["layoutx", null, 0])("rejects invalid explicit classification before task/queue mutation: %s", async targetType => {
    expect((await recognize(req({ assetIds: ["asset"], targetType }), { params })).status).toBe(400);
    expect(f.upsert).not.toHaveBeenCalled(); expect(f.add).not.toHaveBeenCalled();
  });
  it("rejects viewer before reading body and missing/foreign assets before any queue mutation", async () => {
    f.role.mockRejectedValueOnce(new f.ApiException(403, "Forbidden")); const body = req({ assetIds: ["asset"] });
    expect((await recognize(body, { params })).status).toBe(403); expect(body.bodyUsed).toBe(false);
    expect((await recognize(req({ assetIds: ["asset", "foreign"] }), { params })).status).toBe(400);
    expect(f.add).not.toHaveBeenCalled(); expect(f.oldTask).not.toHaveBeenCalled();
  });
  it("read-only recovery scopes receipt to actor/workspace and never queues", async () => {
    f.find.mockResolvedValue({ id: "receipt", jobId: "job", status: "RUNNING" });
    const response = await recognizeReceipt(new Request("http://127.0.0.1/api?mutationId=" + mutationId), { params });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ taskId: "receipt" });
    expect(f.find.mock.calls[0]?.[0].where).toMatchObject({ workspaceId: "workspace", kind: "RECOGNIZE", inputJson: { path: ["userId"], equals: "owner" } });
    expect(f.add).not.toHaveBeenCalled(); expect(f.upsert).not.toHaveBeenCalled();
  });
});

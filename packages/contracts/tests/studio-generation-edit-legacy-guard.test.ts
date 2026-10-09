import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ generation: vi.fn(), version: vi.fn(), studio: vi.fn(), assets: vi.fn(), update: vi.fn(),
  owned: vi.fn(), role: vi.fn(), user: vi.fn(), parse: vi.fn(), create: vi.fn(), edit: vi.fn(), decompose: vi.fn(), lineage: vi.fn(),
  health: vi.fn(), usable: vi.fn(), isLayer: vi.fn(), isVector: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { generation: { findUnique: f.generation }, generationVersion: { findUnique: f.version },
  studioGenerationRequest: { findUnique: f.studio }, asset: { findMany: f.assets }, asyncTask: { update: f.update } } }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
  requireUser: f.user, parse: f.parse, handleError: (error: any) => Response.json({ error: error.message }, { status: error.status ?? 500 }),
  ok: (value: unknown, init?: ResponseInit) => Response.json(value, init) }));
vi.mock("@/lib/workspace", () => ({ requireOwnedWorkspace: f.owned, requireWorkspaceRole: f.role }));
vi.mock("@/lib/queue", () => ({ editQueue: { add: f.edit }, decomposeQueue: { add: f.decompose } }));
vi.mock("@/lib/async-tasks", () => ({ createTask: f.create }));
vi.mock("@/lib/generations", () => ({ getVersionLineage: f.lineage }));
vi.mock("@/lib/layers", () => ({ isLayerVersion: f.isLayer, isVectorImage: f.isVector }));
vi.mock("@/lib/settings", () => ({ getProvidersHealth: f.health, isProviderUsable: f.usable }));

import { POST as editPost } from "../../../apps/web/src/app/api/workspaces/[wsId]/generations/[genId]/versions/[versionId]/edit/route";
import { POST as decomposePost } from "../../../apps/web/src/app/api/workspaces/[wsId]/generations/[genId]/versions/[versionId]/decompose/route";

const routes = [{ name: "edit", post: editPost }, { name: "decompose", post: decomposePost }];
async function run(post: typeof editPost, body: string) {
  const request = new Request("http://local/legacy-action", { method: "POST", headers: { "content-type": "application/json" }, body });
  const json = vi.spyOn(request, "json");
  const response = await post(request, { params: Promise.resolve({ wsId: "w", genId: "g", versionId: "v" }) });
  return { response, json };
}
function noWorkStarted() {
  expect(f.health).not.toHaveBeenCalled(); expect(f.usable).not.toHaveBeenCalled();
  expect(f.parse).not.toHaveBeenCalled(); expect(f.assets).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled(); expect(f.edit).not.toHaveBeenCalled(); expect(f.decompose).not.toHaveBeenCalled();
  expect(f.update).not.toHaveBeenCalled(); expect(f.lineage).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  f.user.mockResolvedValue({ id: "u" }); f.generation.mockResolvedValue({ id: "g", workspaceId: "w" });
  f.version.mockResolvedValue({ id: "v", generationId: "g", imageUrl: "https://legacy-fixture.invalid/image.png", params: {} });
  f.studio.mockResolvedValue(null); f.parse.mockImplementation((schema, value) => schema.parse(value));
  f.create.mockResolvedValue({ id: "task" }); f.edit.mockResolvedValue({ id: "edit-job" }); f.decompose.mockResolvedValue({ id: "decompose-job" });
  f.lineage.mockResolvedValue({ generationId: "g", rootId: "v", versions: [{ id: "v" }] });
  f.isLayer.mockReturnValue(false); f.isVector.mockReturnValue(false);
  f.health.mockResolvedValue({ layer: { configured: true } }); f.usable.mockReturnValue(true);
});

describe.each(routes)("legacy $name product boundary", ({ post }) => {
  it("rejects a product generation before body parsing, provider health or task creation", async () => {
    f.studio.mockResolvedValue({ id: "product-request" });
    // A malformed body would fail if either route touched it before the guard.
    const { response, json } = await run(post, "{");
    expect(response.status).toBe(409); expect(json).not.toHaveBeenCalled();
    expect(f.studio).toHaveBeenCalledWith({ where: { generationId: "g" }, select: { id: true } });
    expect(f.owned).toHaveBeenCalledWith("w", "u");
    expect(f.role).toHaveBeenCalledWith("w", "u", "EDITOR");
    noWorkStarted();
  });

  it.each([null, { id: "g", workspaceId: "foreign" }])("returns 404 for an absent/foreign generation before product lookup", async generation => {
    f.generation.mockResolvedValue(generation);
    const { response, json } = await run(post, "{");
    expect(response.status).toBe(404); expect(json).not.toHaveBeenCalled();
    expect(f.version).not.toHaveBeenCalled(); expect(f.studio).not.toHaveBeenCalled(); noWorkStarted();
  });

  it.each([null, { id: "v", generationId: "foreign" }])("returns 404 for an absent/foreign version before product lookup", async version => {
    f.version.mockResolvedValue(version);
    const { response, json } = await run(post, "{");
    expect(response.status).toBe(404); expect(json).not.toHaveBeenCalled();
    expect(f.studio).not.toHaveBeenCalled(); noWorkStarted();
  });

  it("keeps the EDITOR role requirement ahead of task lookup and work", async () => {
    f.role.mockRejectedValue(Object.assign(new Error("Editor role required"), { status: 403 }));
    const { response, json } = await run(post, "{");
    expect(response.status).toBe(403); expect(json).not.toHaveBeenCalled();
    expect(f.studio).not.toHaveBeenCalled(); noWorkStarted();
  });
});

describe("ordinary legacy actions remain operational", () => {
  it("queues the original edit operation, source and payload and returns its lineage", async () => {
    const input = { op: "RECOLOR", payload: { color: "#123456", instruction: "Keep the product geometry" } };
    const { response, json } = await run(editPost, JSON.stringify(input));
    expect(response.status).toBe(202); expect(json).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledWith({ workspaceId: "w", kind: "EDIT" });
    expect(f.edit).toHaveBeenCalledWith("edit", { workspaceId: "w", generationId: "g", sourceVersionId: "v", op: input.op,
      payload: input.payload, watermarkOverlays: [], taskId: "task" }, { removeOnComplete: 50, removeOnFail: 50 });
    expect(f.update).toHaveBeenCalledWith({ where: { id: "task" }, data: { jobId: "edit-job" } });
    expect(f.lineage).toHaveBeenCalledWith("v");
    expect(await response.json()).toEqual({ jobId: "edit-job", taskId: "task", lineage: { generationId: "g", rootId: "v", versions: [{ id: "v" }] } });
    expect(f.decompose).not.toHaveBeenCalled(); expect(f.health).not.toHaveBeenCalled();
  });

  it("checks legacy layer health and queues the requested layer count and trimmed intent", async () => {
    const { response, json } = await run(decomposePost, JSON.stringify({ layerCount: 3, intent: "  Separate the product and title  " }));
    expect(response.status).toBe(202); expect(json).toHaveBeenCalledTimes(1);
    expect(f.health).toHaveBeenCalledTimes(1); expect(f.usable).toHaveBeenCalledWith({ configured: true });
    expect(f.create).toHaveBeenCalledWith({ workspaceId: "w", kind: "DECOMPOSE" });
    const receipt = await response.json();
    expect(receipt.layerSetId).toMatch(/^[a-f0-9-]{36}$/);
    expect(receipt).toEqual({ layerSetId: receipt.layerSetId, taskId: "task", jobId: "decompose-job", requestedLayerCount: 3 });
    expect(f.decompose).toHaveBeenCalledWith("decompose", { workspaceId: "w", generationId: "g", sourceVersionId: "v", layerSetId: receipt.layerSetId,
      layerCount: 3, intent: "Separate the product and title", taskId: "task" }, { removeOnComplete: 50, removeOnFail: 50 });
    expect(f.update).toHaveBeenCalledWith({ where: { id: "task" }, data: { jobId: "decompose-job" } });
    expect(f.edit).not.toHaveBeenCalled(); expect(f.lineage).not.toHaveBeenCalled();
  });
});

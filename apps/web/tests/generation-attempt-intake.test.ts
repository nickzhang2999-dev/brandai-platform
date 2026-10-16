import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ prepare: vi.fn(), reserve: vi.fn(), quota: vi.fn(), add: vi.fn(), getJob: vi.fn(), generation: vi.fn(), update: vi.fn(), roots: vi.fn(), studio: vi.fn(), project: vi.fn(), brand: vi.fn(), shaped: vi.fn(), rules: vi.fn(), preview: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: { generation: { findUnique: f.generation, updateMany: f.update }, generationVersion: { findMany: f.roots }, studioGenerationRequest: { findUnique: f.studio }, project: { findUnique: f.project }, brandWorkspace: { findUnique: f.brand } } }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
  requireUser: async () => ({ id: "u" }), parse: (schema: any, value: unknown) => schema.parse(value),
  handleError: (error: any) => Response.json({ error: error.message }, { status: error.status ?? 500 }), ok: (value: unknown, init?: ResponseInit) => Response.json(value, init) }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceRole: vi.fn(), requireOwnedWorkspace: vi.fn(), getWorkspaceRole: vi.fn() }));
vi.mock("@/lib/generation-prepare", () => ({ prepareGeneration: f.prepare }));
vi.mock("@/lib/queue", () => ({ generateQueue: { add: f.add, getJob: f.getJob } }));
vi.mock("@/lib/generations", () => ({ getGeneration: f.shaped, listProjectGenerations: vi.fn() }));
vi.mock("@/lib/quota", () => ({ reserveGenerationQuota: f.reserve, assertRegenerateQuota: f.quota }));
vi.mock("@/lib/rules", () => ({ getConfirmedRules: f.rules }));
vi.mock("@/lib/prohibitions", () => ({ serializeProhibition: vi.fn() }));
vi.mock("@/lib/ai-constraints", () => ({ compileAIConstraints: vi.fn(), constraintsEnabled: () => false }));
vi.mock("@/lib/brand-preview", () => ({ composeBrandBrief: () => "Brand brief", getOrCreatePreviewProject: f.preview }));
import { POST as generate } from "../src/app/api/workspaces/[wsId]/generations/route";
import { POST as campaign } from "../src/app/api/workspaces/[wsId]/campaigns/route";
import { POST as preview } from "../src/app/api/workspaces/[wsId]/brand-preview/route";
import { POST as regenerate, GET as readGeneration } from "../src/app/api/workspaces/[wsId]/generations/[genId]/route";
let reserved: any[], row: any;
const targets = [{ key: "square", label: "Square", width: 1024, height: 1024 }];
const run = (post: typeof generate, body: unknown = {}) => post(new Request("http://local/generate", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ wsId: "w" }) });
const retry = () => regenerate(new Request("http://local/regenerate", { method: "POST", body: JSON.stringify({ targets, generationAttemptToken: "spoofed" }) }), { params: Promise.resolve({ wsId: "w", genId: "g" }) });
beforeEach(() => {
  vi.resetAllMocks(); reserved = [];
  row = { id: "g", workspaceId: "w", status: "FAILED", attemptToken: "old-token", createdAt: new Date(0) };
  f.prepare.mockResolvedValue({ generationData: { projectId: "p", workspaceId: "w", sceneType: "SOCIAL_POSTER", sellingPoint: "brief", scene: "", status: "PENDING", attemptToken: "bad-old-data" }, jobData: { workspaceId: "w", versionCount: 1, generationAttemptToken: "bad-old-job" } });
  f.reserve.mockImplementation(async ({ count, make }) => Array.from({ length: count }, (_, i) => { const saved = { id: `g${i}`, ...make(i) }; reserved.push(saved); return { id: saved.id }; }));
  f.add.mockResolvedValue({ id: "job" }); f.shaped.mockResolvedValue({ id: "g", status: "PENDING" }); f.project.mockResolvedValue({ id: "p", workspaceId: "w", name: "Project" });
  f.brand.mockResolvedValue({ name: "Brand" }); f.rules.mockResolvedValue([]); f.preview.mockResolvedValue({ id: "p" }); f.generation.mockImplementation(async () => ({ ...row }));
  f.studio.mockResolvedValue(null); f.roots.mockResolvedValue([]);
  f.update.mockImplementation(async ({ where, data }) => { if (!where.status.in.includes(row.status)) return { count: 0 }; Object.assign(row, data); return { count: 1 }; });
});
const assertIdentity = (index = 0) => {
  const saved = reserved[index], job = f.add.mock.calls[index][1];
  expect(saved.attemptToken).toMatch(/^[a-f0-9-]{36}$/); expect(job.generationAttemptToken).toBe(saved.attemptToken); expect(job.generationId).toBe(saved.id);
  expect(f.reserve.mock.invocationCallOrder[0]).toBeLessThan(f.add.mock.invocationCallOrder[index]);
};
describe("server-issued legacy generation attempt identity", () => {
  it("persists and queues the same new identity for ordinary generation", async () => {
    const response = await run(generate, { projectId: "p", sceneType: "SOCIAL_POSTER", generationAttemptToken: "spoofed" });
    expect(response.status).toBe(202); assertIdentity();
    expect(JSON.stringify(await response.json())).not.toContain(reserved[0].attemptToken);
  });
  it("assigns a distinct identity to each deduplicated Campaign Kit generation", async () => {
    expect((await run(campaign, { projectId: "p", scenes: ["SOCIAL_POSTER", "CAMPAIGN_KV", "SOCIAL_POSTER"], targets })).status).toBe(202);
    expect(reserved).toHaveLength(2); assertIdentity(0); assertIdentity(1); expect(reserved[0].attemptToken).not.toBe(reserved[1].attemptToken);
    expect(f.add.mock.calls.every(call => call[2].attempts === 1)).toBe(true);
  });
  it("binds brand-preview jobs to their reserved generation", async () => {
    expect((await run(preview)).status).toBe(202); assertIdentity();
  });
  it("rotates the identity atomically with every explicit retry and keeps the original queued token immutable", async () => {
    expect((await retry()).status).toBe(202); const first = row.attemptToken;
    expect(first).not.toBe("old-token"); expect(first).not.toBe("spoofed"); expect(f.add.mock.calls[0][1].generationAttemptToken).toBe(first);
    expect(f.update.mock.calls[0][0].data).toMatchObject({ status: "PENDING", attemptToken: first });
    row.status = "FAILED"; expect((await retry()).status).toBe(202);
    expect(row.attemptToken).not.toBe(first); expect(f.add.mock.calls[0][1].generationAttemptToken).toBe(first);
    expect(f.add.mock.calls[1][1].generationAttemptToken).toBe(row.attemptToken);
  });
  it("does not enqueue or rotate an identity when another attempt is already pending", async () => {
    row.status = "PENDING"; expect((await retry()).status).toBe(409); expect(row.attemptToken).toBe("old-token"); expect(f.add).not.toHaveBeenCalled();
  });
  it("does not expose an old job status as the active retry status", async () => {
    const getState = vi.fn().mockResolvedValue("completed"); f.getJob.mockResolvedValue({ id: "old-job", data: { generationId: "g", generationAttemptToken: "stale" }, getState });
    const response = await readGeneration(new Request("http://local/generate?jobId=old-job"), { params: Promise.resolve({ wsId: "w", genId: "g" }) });
    expect(response.status).toBe(200); expect(await response.json()).not.toHaveProperty("job"); expect(getState).not.toHaveBeenCalled();
  });
});

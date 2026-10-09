import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ artifacts: vi.fn(), requests: vi.fn(), outputs: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: {
  studioGeneratedMaterial: { findMany: f.artifacts }, studioGenerationRequest: { findMany: f.requests }, studioGenerationOutput: { findMany: f.outputs },
} }));
import { listStudioGenerationNotifications } from "../../../apps/web/src/lib/studio-notifications";

const now = new Date("2026-10-09T12:10:00Z");
const earlier = new Date("2026-10-09T12:00:00Z");
const later = new Date("2026-10-09T12:09:00Z");
const future = new Date("2026-10-10T12:00:00Z");
let rows: any[];
function request() {
  return { id: "request", workspaceId: "w", userId: "u", projectId: "p", generationId: "g", status: "SUCCEEDED", updatedAt: earlier,
    generation: { projectId: "p", project: { id: "p", workspaceId: "w", archivedAt: null } },
    outputs: [{ id: "output", expiresAt: future }], artifacts: [] as any[] };
}
function artifact() {
  return { outputId: "output", workspaceId: "w", projectId: "p", status: "SUCCEEDED", versionId: "v", assetId: "a", sha256: "a".repeat(64), width: 48, height: 32, mimeType: "image/png", expiresAt: future, updatedAt: later,
    asset: { id: "a", workspaceId: "w", deprecatedAt: null, availableForGeneration: true, generationVersionId: "v", projectLinks: [{ id: "link", projectId: "p" }] }, version: { generationId: "g" } };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); rows = [request()];
  f.artifacts.mockImplementation(async ({ where }) => where.expiresAt ? [] : [{ requestId: "request" }]);
  f.outputs.mockResolvedValue([]);
  f.requests.mockImplementation(async ({ where }) => where.id ? rows : []);
});
afterEach(() => { vi.useRealTimers(); });

describe("metadata-only, owner-scoped product notification projection", () => {
  it("never turns provider success into ready before archive or selects private source bytes", async () => {
    expect(await listStudioGenerationNotifications("w", "u", 30)).toEqual([]);
    const queries = [...f.artifacts.mock.calls, ...f.requests.mock.calls, ...f.outputs.mock.calls].map(([query]) => query);
    for (const query of queries) {
      expect(query.where.workspaceId).toBe("w");
      if (query.where.request) expect(query.where.request.userId).toBe("u");
      else expect(query.where.userId).toBe("u");
      expect(JSON.stringify(query.select)).not.toMatch(/imageUrl|params|prompt|jobData|body/);
    }
    expect(f.artifacts.mock.calls[0][0]).toMatchObject({ orderBy: { updatedAt: "desc" }, take: 30 });
    expect(f.artifacts.mock.calls[1][0]).toMatchObject({ orderBy: { expiresAt: "desc" }, take: 30 });
  });
  it("publishes only an actual saved material and links to its exact request", async () => {
    rows[0].artifacts = [artifact()];
    expect(await listStudioGenerationNotifications("w", "u", 30)).toEqual([{
      id: "studio-generation:request", kind: "STUDIO_GENERATION", status: "SUCCEEDED", title: "生成图片已保存",
      detail: "可返回画布查看或加入图片。", href: "/canvas?workspaceId=w&projectId=p&requestId=request", createdAt: later.toISOString(),
    }]);
  });
  it("keeps failed generation distinct from failed archive and returns no private error body", async () => {
    rows[0].status = "FAILED"; rows[0].error = "fixture-private-provider-response";
    let items = await listStudioGenerationNotifications("w", "u", 30);
    expect(items[0]).toMatchObject({ title: "图片生成未完成", status: "FAILED" });
    expect(JSON.stringify(items)).not.toContain("fixture-private-provider-response");
    rows[0].status = "SUCCEEDED"; rows[0].artifacts = [{ ...artifact(), status: "FAILED" }];
    items = await listStudioGenerationNotifications("w", "u", 30);
    expect(items[0]).toMatchObject({ title: "生成图片保存未完成", status: "FAILED", createdAt: later.toISOString() });
    expect(items[0].detail).toContain("查看原因和可用操作");
  });
  it("removes the old failure during retry and uses the new terminal time on recovery", async () => {
    rows[0].artifacts = [{ ...artifact(), status: "RUNNING" }];
    expect(await listStudioGenerationNotifications("w", "u", 30)).toEqual([]);
    rows[0].artifacts = [{ ...artifact(), updatedAt: now }];
    expect((await listStudioGenerationNotifications("w", "u", 30))[0].createdAt).toBe(now.toISOString());
  });
  it("uses expiry candidates and expiry timestamps even before a sweeper writes failure", async () => {
    f.artifacts.mockImplementation(async ({ where }) => where.expiresAt ? [{ requestId: "request" }] : []);
    rows[0].artifacts = [{ ...artifact(), status: "RUNNING", updatedAt: earlier, expiresAt: later }];
    expect((await listStudioGenerationNotifications("w", "u", 30))[0]).toMatchObject({ status: "FAILED", createdAt: later.toISOString() });
  });
  it("finds expired private outputs that never obtained an archive row", async () => {
    f.artifacts.mockResolvedValue([]); f.outputs.mockResolvedValue([{ requestId: "request" }]);
    rows[0].outputs[0].expiresAt = later;
    expect((await listStudioGenerationNotifications("w", "u", 30))[0]).toMatchObject({ status: "FAILED", createdAt: later.toISOString() });
    expect(f.outputs.mock.calls[0][0]).toMatchObject({ where: { artifact: { is: null } }, orderBy: { expiresAt: "desc" } });
  });
  it("finds archived projects without an archive row by actual project archive time", async () => {
    f.artifacts.mockResolvedValue([]);
    f.requests.mockImplementation(async ({ where }) => where.id ? rows : where.generation ? [{ id: "request" }] : []);
    rows[0].generation.project.archivedAt = later;
    expect((await listStudioGenerationNotifications("w", "u", 30))[0]).toMatchObject({ status: "FAILED", createdAt: later.toISOString() });
    expect(f.requests.mock.calls[0][0].orderBy).toEqual({ generation: { project: { archivedAt: "desc" } } });
  });
  it("does not trust a mismatched ownership graph or invalid published asset", async () => {
    for (const mutation of [
      (r: any) => { r.userId = "another-user"; },
      (r: any) => { r.workspaceId = "another-workspace"; },
      (r: any) => { r.generation.project.id = "another-project"; },
    ]) { rows = [request()]; rows[0].artifacts = [artifact()]; mutation(rows[0]); expect(await listStudioGenerationNotifications("w", "u", 30)).toEqual([]); }
    for (const mutation of [
      (a: any) => { a.asset.projectLinks = [{ id: "foreign", projectId: "elsewhere" }]; },
      (a: any) => { a.outputId = "another-output"; },
      (a: any) => { a.width = -1; },
      (a: any) => { a.projectId = "elsewhere"; },
    ]) { rows = [request()]; rows[0].artifacts = [artifact()]; mutation(rows[0].artifacts[0]); expect((await listStudioGenerationNotifications("w", "u", 30))[0].status).toBe("FAILED"); }
  });
});

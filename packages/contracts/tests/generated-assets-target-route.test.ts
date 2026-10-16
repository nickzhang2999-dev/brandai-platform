import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { GeneratedAssetTargetQueryInput } from "../src/api";

const f = vi.hoisted(() => ({ user: vi.fn(), access: vi.fn(), findMany: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { asset: { findMany: f.findMany } } }));
vi.mock("@/lib/api", () => ({
  requireUser: f.user,
  parse: (schema: { parse(value: unknown): unknown }, value: unknown) => schema.parse(value),
  ok: (value: unknown) => Response.json(value),
  handleError: (error: { status?: number; message: string }) => Response.json({ error: error.message }, {
    status: error instanceof ZodError ? 422 : error.status ?? 500,
  }),
}));
vi.mock("@/lib/workspace", () => ({ requireOwnedWorkspace: f.access }));
vi.mock("@/lib/assets", () => import("../../../apps/web/src/lib/assets"));
import { GET } from "../../../apps/web/src/app/api/workspaces/[wsId]/generated-assets/route";

const ctx = { params: Promise.resolve({ wsId: "workspace-a" }) };
const read = (query = "") => GET(new Request(`https://fixture.invalid/api/workspaces/workspace-a/generated-assets${query}`), ctx);
const fixture = (index: number, input: { workspace?: string; generationWorkspace?: string; projectWorkspace?: string; generationId?: string; versionId?: string } = {}) => {
  const workspaceId = input.workspace ?? "workspace-a";
  const generationId = input.generationId ?? `generation-${index}`;
  const versionId = input.versionId ?? `version-${index}`;
  return {
    id: `asset-${index}`, workspaceId, category: "OTHER", fileName: `image-${index}.png`,
    url: `https://fixture.invalid/image-${index}.png`, mimeType: "image/png", sizeBytes: 10,
    source: "UPLOAD", libraryKind: "GENERATED", tags: [], aiTags: [], isFavorite: false,
    availableForGeneration: true, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)), generationVersionId: versionId,
    generationVersion: { id: versionId, generation: { id: generationId,
      workspaceId: input.generationWorkspace ?? workspaceId, projectId: "project-a", sellingPoint: "fixture", scene: "fixture",
      createdAt: new Date(Date.UTC(2026, 0, 1)), sceneType: "SCENE",
      project: { id: "project-a", workspaceId: input.projectWorkspace ?? workspaceId, name: "Fixture", status: "DRAFT" },
    } },
  };
};
type Row = ReturnType<typeof fixture>;
let rows: Row[];

// A bounded, in-memory relational fake: matching precedes ordering/take, as in
// PostgreSQL. Tests exercise the actual handler and serializer with 301 rows.
function matches(value: unknown, filter: unknown): boolean {
  if (filter === undefined) return true;
  if (typeof filter !== "object" || filter === null) return value === filter;
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "is") return matches(value, expected);
    if (key === "OR") return (expected as unknown[]).some(condition => matches(value, condition));
    if (key === "contains") return String(value).includes(String(expected));
    if (key === "gte") return value instanceof Date && value >= (expected as Date);
    if (expected && typeof expected === "object" && "contains" in expected) return String(record[key]).includes(String(expected.contains));
    return matches(record[key], expected);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  rows = Array.from({ length: 301 }, (_, index) => fixture(index));
  f.user.mockResolvedValue({ id: "reader" });
  f.access.mockResolvedValue({ id: "workspace-a" });
  f.findMany.mockImplementation(async ({ where, orderBy, take }) => rows
    .filter(row => matches(row, where))
    .sort((a, b) => (orderBy.createdAt === "asc" ? 1 : -1) * (a.createdAt.getTime() - b.createdAt.getTime()))
    .slice(0, take));
});

describe("generated asset deep-link boundary", () => {
  it("keeps the existing 300-item unfiltered list and ordering", async () => {
    const response = await read();
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result).toHaveLength(300);
    expect(result[0].id).toBe("asset-300");
    expect(result.some((row: { id: string }) => row.id === "asset-0")).toBe(false);
    expect(f.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "workspace-a", libraryKind: "GENERATED" });
  });

  it.each(["?generationId=generation-0", "?versionId=version-0", "?generationId=generation-0&versionId=version-0"])("retrieves a valid old target before applying the cap: %s", async query => {
    const response = await read(query);
    expect(response.status).toBe(200);
    expect((await response.json()).map((row: { id: string }) => row.id)).toEqual(["asset-0"]);
    expect(f.access).toHaveBeenCalledWith("workspace-a", "reader");
    expect(f.access.mock.invocationCallOrder[0]).toBeLessThan(f.findMany.mock.invocationCallOrder[0]!);
  });

  it("combines target generation and version using AND, never fallback to recent images", async () => {
    expect(await (await read("?generationId=generation-0&versionId=version-1")).json()).toEqual([]);
  });

  it.each([
    { workspace: "workspace-b" },
    { generationWorkspace: "workspace-b" },
    { projectWorkspace: "workspace-b" },
  ])("does not expose a target with foreign asset/source/project ownership: %o", async overrides => {
    rows = [fixture(0, overrides)];
    expect(await (await read("?generationId=generation-0&versionId=version-0")).json()).toEqual([]);
  });

  it("keeps project/status/search filters together with the target restriction", async () => {
    expect(await (await read("?versionId=version-0&projectId=other-project")).json()).toEqual([]);
    expect(await (await read("?versionId=version-0&projectStatus=COMPLETED")).json()).toEqual([]);
    expect(await (await read("?versionId=version-0&q=unmatched")).json()).toEqual([]);
    expect(await (await read("?versionId=version-0&projectId=project-a&projectStatus=DRAFT&q=image-0")).json()).toHaveLength(1);
  });

  it.each(["generationId", "versionId"])("rejects empty/oversized/duplicate %s before querying assets", async field => {
    for (const value of ["", " ", "x".repeat(129)]) {
      expect((await read(`?${new URLSearchParams({ [field]: value })}`)).status).toBe(422);
    }
    expect((await read(`?${field}=a&${field}=b`)).status).toBe(422);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])("does not query assets when authentication/membership is denied (%i)", async status => {
    (status === 401 ? f.user : f.access).mockRejectedValue(Object.assign(new Error("denied"), { status }));
    expect((await read("?versionId=version-0")).status).toBe(status);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it("keeps target values optional but rejects explicit null at the contract boundary", () => {
    expect(GeneratedAssetTargetQueryInput.parse({})).toEqual({});
    expect(GeneratedAssetTargetQueryInput.safeParse({ generationId: null }).success).toBe(false);
    expect(GeneratedAssetTargetQueryInput.safeParse({ versionId: null }).success).toBe(false);
  });
});

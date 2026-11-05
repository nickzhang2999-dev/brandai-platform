import { beforeEach, describe, expect, it, vi } from "vitest";
import { evidencePreviewKind } from "../src/components/brand-knowledge/evidence-preview";

const f = vi.hoisted(() => ({ user: vi.fn(), owner: vi.fn(), rules: vi.fn(), assets: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: {
  brandRule: { findMany: f.rules }, asset: { findMany: f.assets },
}, Prisma: {} }));
vi.mock("@/lib/api", () => ({ requireUser: f.user,
  ok: (value: unknown) => Response.json(value), parse: vi.fn(),
  handleError: (e: any) => Response.json({ error: "denied" }, { status: e.status ?? 500 }),
}));
vi.mock("@/lib/workspace", () => ({ requireOwnedWorkspace: f.owner, requireWorkspaceRole: vi.fn() }));
vi.mock("@/lib/brand-knowledge-safety", () => ({ lockBrandKnowledgeWorkspace: vi.fn() }));
import { GET } from "../src/app/api/workspaces/[wsId]/rules/route";
const get = () => GET(new Request("https://app.invalid/api/workspaces/w/rules"), { params: Promise.resolve({ wsId: "w" }) });
beforeEach(() => {
  vi.resetAllMocks(); f.user.mockResolvedValue({ id: "u" }); f.owner.mockResolvedValue({});
  f.rules.mockResolvedValue([]); f.assets.mockResolvedValue([]);
});

describe("brand evidence preview", () => {
  it("classifies a PDF or SVG as a document, never as an inline image", () => {
    expect(evidencePreviewKind("application/pdf")).toBe("pdf");
    expect(evidencePreviewKind("image/svg+xml")).toBe("file");
    expect(evidencePreviewKind("IMAGE/JPEG; charset=binary")).toBe("image");
    expect(evidencePreviewKind()).toBe("unknown");
  });
  it("resolves legacy PDF evidence MIME from scoped asset data and preserves provenance", async () => {
    f.rules.mockResolvedValue([{ id: "r", evidence: [{ assetId: "a", page: 2, note: "source", mimeType: "image/png" }] }]);
    f.assets.mockResolvedValue([{ id: "a", mimeType: "application/pdf" }]);
    const rows = await (await get()).json();
    expect(rows[0].evidence).toEqual([{ assetId: "a", page: 2, note: "source", mimeType: "application/pdf" }]);
    expect(f.assets).toHaveBeenCalledWith({ where: { workspaceId: "w", id: { in: ["a"] } }, select: { id: true, mimeType: true } });
  });
  it("does not trust stored MIME for missing or foreign assets or note-only evidence", async () => {
    f.rules.mockResolvedValue([{ evidence: [{ assetId: "foreign", mimeType: "image/png" }, { note: "observation", mimeType: "image/jpeg" }] }]);
    expect((await (await get()).json())[0].evidence).toEqual([{ assetId: "foreign" }, { note: "observation" }]);
  });
  it("denies non-members before reading evidence or assets", async () => {
    f.owner.mockRejectedValue({ status: 403 });
    expect((await get()).status).toBe(403);
    expect(f.rules).not.toHaveBeenCalled(); expect(f.assets).not.toHaveBeenCalled();
  });
  it("does not query assets for empty/note-only rules and tolerates legacy malformed evidence", async () => {
    f.rules.mockResolvedValue([{ evidence: [null, "legacy", { note: "observation" }] }]);
    expect((await (await get()).json())[0].evidence).toEqual([{ note: "observation" }]);
    expect(f.assets).not.toHaveBeenCalled();
  });
});

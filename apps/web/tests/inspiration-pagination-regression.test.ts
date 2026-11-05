import { beforeEach, describe, expect, it, vi } from "vitest";
import { pageCatalog, catalogKeywordScore } from "@/lib/inspiration/catalog";
const f = vi.hoisted(() => ({ list: vi.fn(), bookmarks: vi.fn() }));
vi.mock("@brandai/db", () => ({ prisma: { user: { findUnique: async () => ({ isActive: true }) }, inspirationBookmark: { findMany: f.bookmarks } }, Prisma: {} }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceRole: async () => ({ role: "OWNER" }) }));
vi.mock("@/lib/api", () => ({ ApiException: class extends Error {}, requireUser: async () => ({ id: "fixture-user" }), ok: (value: unknown) => Response.json(value), handleError: () => Response.json({}, { status: 500 }), parse: vi.fn() }));
vi.mock("@/lib/inspiration/library", () => ({ resolveLibrary: async () => ({ id: "fixture-library", kind: "WORKSPACE", ownerId: "fixture-user" }) }));
vi.mock("@/lib/inspiration/service", () => ({ currentCases: f.list, keywordScore: (card: never, query: string) => catalogKeywordScore(card, query), getCase: vi.fn(), requireEnabled: vi.fn() }));
vi.mock("@/lib/inspiration/semantic", () => ({ embeddingConfig: () => null, embedTexts: vi.fn(), rankHybrid: (cards: Array<{ keywordScore: number }>) => ({ searchMode: "keyword-tags", cases: cards.filter(card => card.keywordScore > 0) }) }));
import { currentAnalysisCases, requireCurrentEvidence } from "@/lib/inspiration/access";
import { retrieveInspirationCases } from "@/lib/inspiration/retrieval";
import { GET } from "../src/app/api/workspaces/[wsId]/inspiration/bookmarks/route";
const cards = Array.from({ length: 201 }, (_, index) => ({ libraryId: "fixture-library", caseId: `case-${String(index).padStart(3, "0")}`, revision: 1,
  title: index === 200 ? "唯一星际包装" : "日常案例", summary: "已核验资料", brandOrTeam: "示例团队", analysisAllowed: true,
  contentType: "reference" as const, taxonomyStatus: "reviewed" as const, tags: { industry: [], medium: [], task: [] }, images: [], sources: [], claims: [] }));
beforeEach(() => { vi.clearAllMocks(); f.list.mockResolvedValue({ cases: cards }); });
describe("pagination used as a complete library", () => {
  it("retains a still valid fifth-page reference during analysis authorization", async () => {
    expect(pageCatalog(cards).cases).toHaveLength(50);
    expect(pageCatalog(cards, {}, { cursor: "case-199" }).cases[0]!.caseId).toBe(cards[200]!.caseId);
    expect(await currentAnalysisCases("fixture-brand", "fixture-user", [cards[200]!])).toEqual([cards[200]!]);
    await expect(requireCurrentEvidence("fixture-brand", "fixture-user", [cards[200]!])).resolves.toBeUndefined();
  });
  it("retrieves a unique matching case after the first fifty", async () => {
    expect(catalogKeywordScore(cards[200]!, "唯一星际包装")).toBeGreaterThan(0);
    expect(await retrieveInspirationCases("fixture-brand", "fixture-user", "唯一星际包装", new AbortController().signal)).toMatchObject([cards[200]!]);
  });
  it("retains a saved fifth-page bookmark", async () => {
    f.bookmarks.mockResolvedValue([{ id: "fixture-bookmark", libraryId: "fixture-library", caseId: cards[200]!.caseId, revision: 1, projectId: "", note: "" }]);
    const response = await GET(new Request("http://127.0.0.1/bookmarks"), { params: Promise.resolve({ wsId: "fixture-brand" }) });
    expect(response.status).toBe(200);
    const body = await response.json(); expect(body.items[0].case.caseId).toBe(cards[200]!.caseId); expect(body.items[0].unavailable).toBe(false);
  });
});

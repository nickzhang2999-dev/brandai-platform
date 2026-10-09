import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ terms: vi.fn(), ai: vi.fn(), fetch: vi.fn() }));
vi.mock("../../db/src/index", () => ({ prisma: { complianceTerm: { findMany: f.terms } } }));
vi.mock("@/lib/ai", () => ({ ai: { complianceCheck: f.ai } }));
import { runPrecheck } from "../../../apps/web/src/lib/precheck";
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal("fetch", f.fetch);
  f.terms.mockResolvedValue([]); f.ai.mockRejectedValue(new Error("fixture end"));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const input = { workspaceId: "w", text: "test" };
describe("product precheck shares generation deadline", () => {
  it("rejects an expired request without reading DB or dispatching compliance", async () => {
    const c = new AbortController(); c.abort(new Error("expired"));
    await expect(runPrecheck(input, { signal: c.signal })).rejects.toThrow("expired");
    expect(f.terms).not.toHaveBeenCalled(); expect(f.ai).not.toHaveBeenCalled();
  });
  it("prevents a late term-library result from dispatching a new AI request", async () => {
    const c = new AbortController(); let finish!: (value: []) => void;
    f.terms.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const result = runPrecheck(input, { signal: c.signal });
    c.abort(new Error("expired")); await expect(result).rejects.toThrow("expired");
    finish([]); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.ai).not.toHaveBeenCalled();
  });
  it("passes the same signal and a smaller bounded compliance body limit", async () => {
    const c = new AbortController();
    await expect(runPrecheck(input, { signal: c.signal, maxResponseBytes: 48 * 1024 * 1024 })).rejects.toThrow("fixture end");
    expect(f.ai).toHaveBeenCalledWith(expect.objectContaining({ text: "test" }), { signal: c.signal, maxResponseBytes: 4 * 1024 * 1024 });
  });
  it("does not fall through to another AI call after self-route abort", async () => {
    const c = new AbortController();
    f.fetch.mockImplementation(async () => { c.abort(new Error("expired")); throw c.signal.reason; });
    await expect(runPrecheck({ ...input, baseUrl: "http://127.0.0.1" }, { signal: c.signal })).rejects.toThrow("expired");
    expect(f.terms).not.toHaveBeenCalled(); expect(f.ai).not.toHaveBeenCalled();
  });
  it("keeps legacy one-argument calls unchanged", async () => {
    await expect(runPrecheck(input)).rejects.toThrow("fixture end");
    expect(f.ai.mock.calls[0]).toHaveLength(1);
  });
});

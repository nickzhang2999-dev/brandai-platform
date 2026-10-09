import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ dns: vi.fn(), fetch: vi.fn() }));
vi.mock("node:dns/promises", () => ({ resolve4: f.dns }));
const current = { parserRevision: "grounded-six-slot-r6", generationRevision: "gpt-image-2-size-quality-r1", visualCheckRevision: "studio-visual-check-evidence-r1", providerRetryRevision: "single-provider-attempt-r1" };
const older = { parserRevision: current.parserRevision, generationRevision: current.generationRevision };
const load = () => import("../../../apps/web/src/lib/ai-service");
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); vi.stubGlobal("fetch", f.fetch);
  vi.stubEnv("BRANDAI_AI_SERVICE_URL", "http://configured.invalid:8000");
  vi.stubEnv("AI_SERVICE_URL", "http://unused.invalid:8000");
  f.dns.mockResolvedValue(["10.0.0.2", "10.0.0.1"]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("product visual-check service capability gate", () => {
  it("rejects an old explicit image service and a legacy cache lacking single-attempt support", async () => {
    f.fetch.mockResolvedValue(Response.json(older)); const { resolveAiService } = await load();
    await resolveAiService();
    await expect(resolveAiService({ requireSingleAttempt: true })).rejects.toThrow("single-provider-attempt revision");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("requires both retry and visual evidence capabilities for product checks", async () => {
    f.fetch.mockImplementation(async () => Response.json({ ...current, providerRetryRevision: undefined })); const { resolveAiService } = await load();
    await resolveAiService({ requireVisualCheck: true });
    await expect(resolveAiService({ requireVisualCheck: true, requireSingleAttempt: true })).rejects.toThrow("single-provider-attempt revision");
    f.fetch.mockResolvedValue(Response.json(current));
    expect(await resolveAiService({ requireVisualCheck: true, requireSingleAttempt: true })).toMatchObject(current);
  });
  it("selects only a shared container with compatible single-attempt behavior", async () => {
    vi.stubEnv("BRANDAI_AI_SERVICE_URL", "http://ai:8000");
    f.fetch.mockImplementation(async (url: string) => Response.json(url.includes("10.0.0.1") ? older : current));
    const { resolveAiService } = await load(); expect((await resolveAiService({ requireSingleAttempt: true })).base).toBe("http://10.0.0.2:8000");
  });
  it("keeps explicit legacy resolution authoritative without probing health", async () => {
    const { resolveAiService } = await load();
    expect(await resolveAiService()).toEqual({ base: "http://configured.invalid:8000", source: "configured" });
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.dns).not.toHaveBeenCalled();
  });
  it("requires evidence support even on an explicitly configured endpoint", async () => {
    f.fetch.mockResolvedValue(Response.json(older)); const { resolveAiService } = await load();
    await expect(resolveAiService({ requireVisualCheck: true })).rejects.toThrow("visual-check evidence revision");
    expect(f.fetch).toHaveBeenCalledWith("http://configured.invalid:8000/health", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
    expect(f.dns).not.toHaveBeenCalled();
  });
  it("does not reuse a legacy explicit URL cache as proof of evidence capability", async () => {
    f.fetch.mockResolvedValue(Response.json(older)); const { resolveAiService } = await load();
    await resolveAiService(); await expect(resolveAiService({ requireVisualCheck: true })).rejects.toThrow("visual-check evidence revision");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(await resolveAiService()).toEqual({ base: "http://configured.invalid:8000", source: "configured" });
  });
  it("caches verified explicit capabilities and retains configured source semantics", async () => {
    f.fetch.mockResolvedValue(Response.json(current)); const { resolveAiService } = await load();
    expect(await resolveAiService({ requireVisualCheck: true })).toMatchObject({ base: "http://configured.invalid:8000", source: "configured", visualCheckRevision: current.visualCheckRevision });
    await resolveAiService({ requireVisualCheck: true }); await resolveAiService(); expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it("selects a shared-network container with all three required revisions", async () => {
    vi.stubEnv("BRANDAI_AI_SERVICE_URL", "http://ai:8000");
    f.fetch.mockImplementation(async (url: string) => Response.json(url.includes("10.0.0.1") ? older : current));
    const { resolveAiService } = await load(); expect(await resolveAiService({ requireVisualCheck: true })).toMatchObject({ base: "http://10.0.0.2:8000", source: "revision-match", ...current });
  });
  it("reprobes an incompatible shared cache while preserving legacy parser/generation selection", async () => {
    vi.stubEnv("BRANDAI_AI_SERVICE_URL", "http://ai:8000");
    f.fetch.mockImplementation(async (url: string) => Response.json(url.includes("10.0.0.1") ? older : current));
    const { resolveAiService } = await load(); expect((await resolveAiService()).base).toBe("http://10.0.0.1:8000");
    expect((await resolveAiService({ requireVisualCheck: true })).base).toBe("http://10.0.0.2:8000"); expect(f.dns).toHaveBeenCalledTimes(2);
  });
  it("fails closed without falling back to a shared alias or a mismatched generation revision", async () => {
    vi.stubEnv("BRANDAI_AI_SERVICE_URL", "http://ai:8000");
    f.fetch.mockImplementation(async (url: string) => Response.json(url.includes("10.0.0.1") ? older : { ...current, generationRevision: "old-generation" }));
    const { resolveAiService } = await load(); await expect(resolveAiService({ requireVisualCheck: true })).rejects.toThrow("visual-check evidence revisions");
    expect(f.fetch.mock.calls.every(([url]) => url !== "http://ai:8000/health")).toBe(true);
  });
  it.each([123, null, "studio-visual-check-evidence-r0"])("rejects invalid or stale capability %j", async visualCheckRevision => {
    f.fetch.mockResolvedValue(Response.json({ ...current, visualCheckRevision })); const { resolveAiService } = await load();
    await expect(resolveAiService({ requireVisualCheck: true })).rejects.toThrow("visual-check evidence revision");
  });
  it("refuses failed or unreachable explicit health before returning a paid-check endpoint", async () => {
    f.fetch.mockResolvedValueOnce(new Response("unavailable", { status: 503 })).mockRejectedValueOnce(new Error("offline"));
    const { resolveAiService } = await load(); await expect(resolveAiService({ requireVisualCheck: true })).rejects.toThrow(); await expect(resolveAiService({ requireVisualCheck: true })).rejects.toThrow();
  });
});

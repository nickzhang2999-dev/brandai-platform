import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ service: vi.fn(), settings: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/ai-service", () => ({ resolveAiService: f.service }));
vi.mock("@/lib/settings", () => ({ getEffectiveAiSettings: f.settings }));
vi.mock("@/lib/ai-response", async () => import("../../../apps/web/src/lib/ai-response"));
import { ai } from "../../../apps/web/src/lib/ai";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", f.fetch);
  f.service.mockResolvedValue({ base: "http://internal-ai.invalid" });
  f.settings.mockResolvedValue({ image: {}, layer: {}, vlm: {} });
  f.fetch.mockImplementation(async () => Response.json({ versions: [] }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
// This isolated fixture checks transport only. No provider or DB is contacted.
const body = {} as Parameters<typeof ai.generate>[0];

describe("product AI transport opt-in", () => {
  it("never resolves services or dispatches after the deadline already elapsed", async () => {
    const controller = new AbortController();
    controller.abort(new Error("expired"));
    await expect(ai.generate(body, { signal: controller.signal })).rejects.toThrow("expired");
    expect(f.service).not.toHaveBeenCalled(); expect(f.settings).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("prevents late service discovery from dispatching a paid request", async () => {
    const controller = new AbortController();
    let resolveService!: (value: { base: string }) => void;
    f.service.mockImplementation(() => new Promise(resolve => { resolveService = resolve; }));
    const result = ai.generate(body, { signal: controller.signal });
    controller.abort(new Error("expired before dispatch"));
    await expect(result).rejects.toThrow("expired before dispatch");
    resolveService({ base: "http://late-ai.invalid" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("shares the worker signal with fetch and bounds actual response bytes", async () => {
    const controller = new AbortController();
    f.fetch.mockImplementation(async () => new Response("x".repeat(65)));
    await expect(ai.generate(body, { signal: controller.signal, maxResponseBytes: 64 })).rejects.toThrow("超过限制");
    expect(f.fetch).toHaveBeenCalledWith("http://internal-ai.invalid/v1/generate", expect.objectContaining({ signal: controller.signal, method: "POST", cache: "no-store" }));
  });
  it("does not return upstream body secrets in product errors", async () => {
    f.fetch.mockImplementation(async () => new Response("fixture-private-value", { status: 503 }));
    const error = await ai.generate(body, {}).catch(value => value);
    expect(error.message).toContain("HTTP 503"); expect(error.message).not.toContain("fixture-private-value");
  });
  it("keeps legacy callers' behavior opt-out", async () => {
    expect(await ai.generate(body)).toEqual({ versions: [] });
    expect(f.fetch.mock.calls[0]?.[1]).not.toHaveProperty("signal");
  });
  it.each([{ provider: "mock", apiKey: "fixture" }, { provider: " MOCK ", apiKey: "fixture" }, { provider: "", apiKey: "fixture" }, { provider: "openai", apiKey: "" }, { provider: "openai", apiKey: "  " }])(
    "refuses a product call when the actual outgoing settings snapshot is unavailable: %j", async image => {
      f.settings.mockResolvedValue({ image, layer: {}, vlm: {} });
      await expect(ai.generate(body, { requireRealImageProvider: true })).rejects.toThrow("未调用演示模型");
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );
  it("sends headers from the very settings snapshot checked as a real provider", async () => {
    f.settings.mockResolvedValue({ image: { provider: "openai", apiKey: "fixture-private", model: "fixture-model" }, layer: {}, vlm: {} });
    expect(await ai.generate(body, { requireRealImageProvider: true })).toEqual({ versions: [] });
    expect(f.settings).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ "X-OV-Image-Provider": "openai", "X-OV-Image-Key": "fixture-private" }) }));
  });
  it.each([{ provider: "mock", apiKey: "fixture" }, { provider: " MOCK ", apiKey: "fixture" }, { provider: "", apiKey: "fixture" }, { provider: "openai", apiKey: "  " }])(
    "does not accept a missing or mock VLM as a real product check: %j", async vlm => {
      f.settings.mockResolvedValue({ image: {}, layer: {}, vlm });
      await expect(ai.complianceCheck({}, { requireRealVlmProvider: true })).rejects.toThrow("未执行品牌检查");
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );
  it("uses the checked VLM headers without requiring an image-generation provider", async () => {
    f.settings.mockResolvedValue({ image: {}, layer: {}, vlm: { provider: "openai", apiKey: "fixture-vlm", model: "fixture-model" } });
    await ai.complianceCheck({}, { requireRealVlmProvider: true });
    expect(f.settings).toHaveBeenCalledOnce();
    expect(f.service).toHaveBeenCalledWith({ requireVisualCheck: true });
    expect(f.fetch).toHaveBeenCalledWith("http://internal-ai.invalid/v1/compliance/check", expect.objectContaining({ headers: expect.objectContaining({ "X-OV-Vlm-Provider": "openai", "X-OV-Vlm-Key": "fixture-vlm" }) }));
  });
});

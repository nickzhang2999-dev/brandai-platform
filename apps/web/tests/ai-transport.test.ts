import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ service: vi.fn(), settings: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/ai-service", () => ({ resolveAiService: f.service }));
vi.mock("@/lib/settings", () => ({ getEffectiveAiSettings: f.settings }));
vi.mock("@/lib/ai-response", async () => import("../src/lib/ai-response"));
import { ai } from "../src/lib/ai";
import { AiServiceFailure } from "../src/lib/ai-failure";

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

it("keeps a model 429 distinct from its internal 502 and never retries or forwards task IDs into the model payload", async () => {
  const requestId = "sgr_" + "c".repeat(32);
  f.settings.mockResolvedValue({ image: { provider:"openai", apiKey:"fixture" }, layer:{}, vlm:{} });
  f.fetch.mockImplementation(async () => Response.json({schemaVersion:1,error:{code:"PROVIDER_RATE_LIMITED",stage:"provider",upstreamStatus:429}}, {status:502}));
  const request = { imageUrl:"data:image/png;base64,YQ==", generation:{providerRetryPolicy:"never"} } as Parameters<typeof ai.studioEdit>[0];
  const error = await ai.studioEdit(request, {requestId}).catch(error => error);
  expect(error).toBeInstanceOf(AiServiceFailure); expect(error.info.upstreamStatus).toBe(429);
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.fetch.mock.calls[0][1].headers["X-Novart-Request-Id"]).toBe(requestId);
  expect(JSON.parse(f.fetch.mock.calls[0][1].body)).toEqual(request);
});
it("does not send malformed diagnostic identities", async () => {
  await ai.generate(body, {requestId:"private-url-or-token"});
  expect(f.fetch.mock.calls[0][1].headers).not.toHaveProperty("X-Novart-Request-Id");
});

it("requires structured conversation service capability and existing real VLM with one POST", async () => {
  f.settings.mockResolvedValue({ image: {}, layer: {}, vlm: { provider: "openai", apiKey: "unit-fixture", model: "configured-model" } });
  const request = { schemaVersion: 1, text: "poster", references: [], quickEditTargetId: null, previousResultReferenceId: null, providerRetryPolicy: "never" } as Parameters<typeof ai.studioConversationIntent>[0];
  await ai.studioConversationIntent(request, { signal: AbortSignal.timeout(1000), maxResponseBytes: 16384 });
  expect(f.service).toHaveBeenCalledWith({ requireSingleAttempt: true, requireStudioConversationIntent: true });
  expect(f.fetch).toHaveBeenCalledOnce(); expect(f.fetch.mock.calls[0][0]).toBe("http://internal-ai.invalid/v1/studio/conversation-intent");
  expect(JSON.parse(f.fetch.mock.calls[0][1].body).providerRetryPolicy).toBe("never");
});

it("requires real decomposition capability and one provider attempt before dispatch", async () => {
  const request = { imageUrl: "data:image/png;base64,YQ==", layerCount: 2 } as Parameters<typeof ai.decompose>[0];
  f.settings.mockResolvedValue({ image: {}, layer: { provider: "fal", apiKey: "fixture-layer" }, vlm: {} });
  await ai.decompose(request, { requireRealLayerProvider: true });
  expect(f.service).toHaveBeenCalledWith({ requireStudioDecomposition: true, requireSingleAttempt: true });
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.fetch.mock.calls[0][0]).toBe("http://internal-ai.invalid/v1/decompose");
  expect(JSON.parse(f.fetch.mock.calls[0][1].body)).toEqual({ ...request, providerRetryPolicy: "never" });
  expect(f.fetch.mock.calls[0][1].headers).toMatchObject({ "X-OV-Layer-Provider": "fal", "X-OV-Layer-Key": "fixture-layer" });
});
it("never posts decomposition when service capability cannot be confirmed", async () => {
  f.settings.mockResolvedValue({ image: {}, layer: { provider: "fal", apiKey: "fixture-layer" }, vlm: {} });
  f.service.mockRejectedValue(new Error("Unsupported real-layer decomposition revision"));
  await expect(ai.decompose({} as never, { requireRealLayerProvider: true })).rejects.toThrow("Unsupported real-layer decomposition revision");
  expect(f.fetch).not.toHaveBeenCalled();
});
it.each(["decomposeSubmit", "decomposePoll"] as const)("requires queue capability and real layer settings for %s without lower-layer retries", async method => {
  f.settings.mockResolvedValue({ image: {}, layer: { provider: "fal", apiKey: "fixture-layer" }, vlm: {} });
  const request = method === "decomposeSubmit" ? { imageUrl: "data:image/png;base64,YQ==", layerCount: 2 }
    : { requestId: "fixture-request", endpointId: "fal-ai/qwen-image-layered", providerRetryPolicy: "never" };
  await ai[method](request as never);
  expect(f.service).toHaveBeenCalledWith({ requireStudioDecompositionQueue: true, requireSingleAttempt: true });
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.fetch.mock.calls[0][0]).toBe(`http://internal-ai.invalid/v1/decompose/${method === "decomposeSubmit" ? "submit" : "poll"}`);
  expect(JSON.parse(f.fetch.mock.calls[0][1].body)).toEqual({ ...request, providerRetryPolicy: "never" });
  expect(f.fetch.mock.calls[0][1].headers).toMatchObject({ "X-OV-Layer-Provider": "fal", "X-OV-Layer-Key": "fixture-layer" });
});
it("refuses queue submission without real credentials or when only the old service is available", async () => {
  await expect(ai.decomposeSubmit({} as never)).rejects.toThrow("未调用演示模型");
  expect(f.fetch).not.toHaveBeenCalled();
  f.settings.mockResolvedValue({ image: {}, layer: { provider: "fal", apiKey: "fixture-layer" }, vlm: {} });
  f.service.mockRejectedValue(new Error("durable layer queue tasks unavailable"));
  await expect(ai.decomposeSubmit({} as never)).rejects.toThrow("durable layer queue tasks");
  expect(f.fetch).not.toHaveBeenCalled();
});
it("requires single-attempt capability for legacy decomposition without requiring real layer setup", async () => {
  const request = { imageUrl: "data:image/png;base64,YQ==", layerCount: 2 } as Parameters<typeof ai.decompose>[0];
  await ai.decompose(request);
  expect(f.service).toHaveBeenCalledWith({ requireSingleAttempt: true });
  expect(JSON.parse(f.fetch.mock.calls[0][1].body)).toEqual({ ...request, providerRetryPolicy: "never" });
});

it("requires real image configuration and edit capability without inserting a forbidden top-level retry field", async () => {
  const request = { imageUrl: "data:image/png;base64,YQ==", generation: { providerRetryPolicy: "never" } } as Parameters<typeof ai.studioEdit>[0];
  f.settings.mockResolvedValue({ image: { provider: "openai", apiKey: "fixture" }, layer: {}, vlm: {} });
  await ai.studioEdit(request);
  expect(f.service).toHaveBeenCalledWith({ requireStudioEdit: true, requireSingleAttempt: true });
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.fetch.mock.calls[0][0]).toBe("http://internal-ai.invalid/v1/studio/edit");
  expect(JSON.parse(f.fetch.mock.calls[0][1].body)).toEqual(request);
  expect(f.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
});
it("refuses image-edit transport when service revision or actual provider setup is unavailable", async () => {
  await expect(ai.studioEdit({} as never)).rejects.toThrow("未调用演示模型"); expect(f.fetch).not.toHaveBeenCalled();
  f.settings.mockResolvedValue({ image: { provider: "openai", apiKey: "fixture" }, layer: {}, vlm: {} });
  f.service.mockRejectedValue(new Error("Unsupported edit revision"));
  await expect(ai.studioEdit({} as never)).rejects.toThrow("Unsupported edit revision"); expect(f.fetch).not.toHaveBeenCalled();
});

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
  it("bounds legacy callers and disables automatic paid retries by default", async () => {
    expect(await ai.generate(body)).toEqual({ versions: [] });
    expect(f.fetch.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(f.fetch.mock.calls[0]?.[1].body).providerRetryPolicy).toBe("never");
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
    expect(f.service).toHaveBeenCalledWith({ requireSingleAttempt: true });
    expect(JSON.parse(f.fetch.mock.calls[0]?.[1].body).providerRetryPolicy).toBe("never");
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
    expect(f.service).toHaveBeenCalledWith({ requireVisualCheck: true, requireSingleAttempt: true });
    expect(JSON.parse(f.fetch.mock.calls[0]?.[1].body).providerRetryPolicy).toBe("never");
    expect(f.fetch).toHaveBeenCalledWith("http://internal-ai.invalid/v1/compliance/check", expect.objectContaining({ headers: expect.objectContaining({ "X-OV-Vlm-Provider": "openai", "X-OV-Vlm-Key": "fixture-vlm" }) }));
  });
  it("also prevents lower-layer retries in the product's text precheck", async () => {
    await ai.complianceCheck({ text: "fixture text" }, { requireRealImageProvider: true });
    expect(f.service).toHaveBeenCalledWith({ requireSingleAttempt: true });
    expect(JSON.parse(f.fetch.mock.calls[0]?.[1].body)).toEqual({ text: "fixture text", providerRetryPolicy: "never" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});


it.each(["ingestWebsite", "recognize", "describe", "parseManual", "summarize", "edit"] as const)(
  "forwards worker cancellation and never-retry policy for %s", async method => {
    const controller = new AbortController();
    await ai[method]({} as never, { signal: controller.signal });
    expect(f.fetch.mock.calls[0][1].signal).toBe(controller.signal);
    expect(JSON.parse(f.fetch.mock.calls[0][1].body).providerRetryPolicy).toBe("never");
    expect(f.service).toHaveBeenCalledWith({ requireSingleAttempt: true });
  });

it.each(["discovery", "fetch", "body"])("the default five-minute deadline bounds stalled %s without worker options", async stage => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  if (stage === "discovery") f.service.mockImplementation(() => new Promise(() => {}));
  if (stage === "fetch") f.fetch.mockImplementation(() => new Promise(() => {}));
  if (stage === "body") f.fetch.mockResolvedValue(new Response(new ReadableStream({ start() {} })));
  const pending = ai.generate(body);
  const check = expect(pending).rejects.toThrow("default deadline elapsed");
  await new Promise(resolve => setTimeout(resolve, 0));
  controller.abort(new Error("default deadline elapsed"));
  await check;
  expect(timeout).toHaveBeenCalledWith(300000);
  expect(f.fetch.mock.calls.length).toBe(stage === "discovery" ? 0 : 1);
});

it("legacy errors use the bounded redacted parser too", async () => {
  f.fetch.mockResolvedValue(new Response("private-provider-secret", { status: 500 }));
  const error = await ai.recognize({ assets: [] }).catch(error => error);
  expect(error.message).not.toContain("private-provider-secret");
  expect(f.fetch).toHaveBeenCalledOnce();
});

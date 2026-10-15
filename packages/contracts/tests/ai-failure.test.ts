import { describe, expect, it } from "vitest";
import { AiFailureResponse } from "../src/ai-failure";
import { AiServiceFailure, readAiFailure } from "../../../apps/web/src/lib/ai-failure";

const envelope = { schemaVersion: 1, error: { code: "PROVIDER_RATE_LIMITED", stage: "provider", upstreamStatus: 429 } };
describe("bounded safe AI failure transport", () => {
  it("preserves model throttling through an internal 502 without exposing provider text", async () => {
    const result = await readAiFailure(Response.json(envelope, { status: 502 }));
    expect(result).toBeInstanceOf(AiServiceFailure);
    expect(result.message).toContain("限制请求");
    expect((result as AiServiceFailure).info.upstreamStatus).toBe(429);
  });
  it.each([
    { ...envelope, private: "secret" },
    { ...envelope, error: { ...envelope.error, detail: "private-token" } },
    { ...envelope, error: { ...envelope.error, code: "private-error" } },
    { ...envelope, error: { ...envelope.error, upstreamStatus: "429" } },
    { ...envelope, schemaVersion: 2 },
  ])("rejects noncanonical error data and uses safe fallback", async value => {
    expect(AiFailureResponse.safeParse(value).success).toBe(false);
    const error = await readAiFailure(Response.json(value, { status: 502 }));
    expect(error).not.toBeInstanceOf(AiServiceFailure);
    expect(error.message).toBe("图片服务请求失败（HTTP 502），请稍后重试或联系管理员。");
  });
  it("cancels oversized error streams", async () => {
    let cancelled = false;
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("private".repeat(1000))); }, cancel() { cancelled = true; } });
    const error = await readAiFailure(new Response(stream, { status: 502 }));
    expect(cancelled).toBe(true); expect(error.message).not.toContain("private");
  });
  it("bounds stalled error streams even when the parent has no deadline", async () => {
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    const started = Date.now();
    const error = await readAiFailure(new Response(stream, { status: 502 }));
    expect(cancelled).toBe(true); expect(Date.now() - started).toBeLessThan(3000);
    expect(error.message).toContain("HTTP 502");
  });
});

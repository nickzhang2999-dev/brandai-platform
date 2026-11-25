import { describe, expect, it } from "vitest";
import { createOwnedEditorApi } from "../src/components/owned-canvas/owned-editor-api";
import { generationReadFailure, retryAfterMs } from "../src/components/owned-canvas/owned-generation-read-policy";
import { NovartApiError } from "../src/lib/novart-api-client";

describe("polling an existing generation", () => {
  it.each([null, 408, 500, 502, 503])("backs off on transient status %s", status => {
    const error = new NovartApiError("temporary", status);
    expect(generationReadFailure(error, 1, 60_000, () => 0)).toMatchObject({ stop: false, delay: 750 });
    expect(generationReadFailure(error, 2, 60_000, () => 1).delay).toBe(2500);
    expect(generationReadFailure(error, 5, 60_000).stop).toBe(true);
  });
  it.each([400, 401, 403, 404, 422, 200])("stops on non-transient status %s", status => {
    expect(generationReadFailure(new NovartApiError("read", status), 1, 60_000).stop).toBe(true);
  });
  it("handles HTTP dates and a throttle longer than the observation window", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(retryAfterMs(new Date(now + 9000).toUTCString(), now)).toBe(9000);
    expect(retryAfterMs("1.5", now)).toBeUndefined();
    expect(generationReadFailure(new NovartApiError("busy", 429, undefined, false, 9000), 1, 5000)).toMatchObject({ delay: 9000, stop: true });
  });
  it.each(["{}", "proxy busy"])("preserves Retry-After on a throttled JSON or text GET", async body => {
    const api = createOwnedEditorApi("w", "p", "u", { origin: "http://localhost", fetcher: async (_url, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      return new Response(body, { status: 429, headers: { "Retry-After": "12" } });
    }});
    await expect(api.listGenerations()).rejects.toMatchObject({ status: 429, retryAfterMs: 12000 });
  });
});

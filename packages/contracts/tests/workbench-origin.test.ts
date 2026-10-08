import { describe, expect, it } from "vitest";
import { isWorkbenchSameOrigin } from "../../../apps/web/src/lib/workbench-origin";

describe("workbench origin behind Next and HTTPS proxy", () => {
  it("uses incoming host even when Next constructs an internal localhost URL", () => {
    expect(isWorkbenchSameOrigin(new Request("http://localhost:3000/api", { headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" } }))).toBe(true);
  });
  it("supports the proxy's HTTPS protocol without trusting forwarded-host from a browser", () => {
    expect(isWorkbenchSameOrigin(new Request("http://localhost:3000/api", { headers: { host: "preview.test", "x-forwarded-proto": "https", origin: "https://preview.test" } }))).toBe(true);
    expect(isWorkbenchSameOrigin(new Request("http://localhost:3000/api", { headers: { host: "preview.test", "x-forwarded-host": "foreign.test", "x-forwarded-proto": "https", origin: "https://foreign.test" } }))).toBe(false);
  });
  it("rejects null, malformed, foreign and wrong-protocol origins", () => {
    for (const origin of ["null", "bad", "https://foreign.test", "http://preview.test"]) {
      expect(isWorkbenchSameOrigin(new Request("http://localhost:3000/api", { headers: { host: "preview.test", "x-forwarded-proto": "https", origin } }))).toBe(false);
    }
  });
});

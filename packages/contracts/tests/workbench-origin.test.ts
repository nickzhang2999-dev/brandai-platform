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
  it("accepts the configured public origin when the proxy rewrites Host and protocol", () => {
    const req = new Request("http://localhost:3000/api", { headers: { host: "localhost:3000", "x-forwarded-proto": "http", origin: "https://preview.test" } });
    expect(isWorkbenchSameOrigin(req, "https://preview.test")).toBe(true);
    expect(isWorkbenchSameOrigin(req, "https://another.test")).toBe(false);
  });
  it("does not let spoofed request headers override the configured public origin", () => {
    for (const origin of ["https://foreign.test", "http://preview.test", "https://preview.test:444", "null", "https://preview.test/path", "https://someone@preview.test"]) {
      const req = new Request("http://localhost:3000/api", { headers: { host: "foreign.test", "x-forwarded-host": "foreign.test", "x-forwarded-proto": "https", origin } });
      expect(isWorkbenchSameOrigin(req, "https://preview.test")).toBe(false);
    }
  });
  it("fails closed on invalid server configuration instead of trusting incoming Host", () => {
    const req = new Request("https://preview.test/api", { headers: { host: "preview.test", origin: "https://preview.test" } });
    for (const publicUrl of ["", "bad", "file:///preview.test", "https://user:password@preview.test"]) {
      expect(isWorkbenchSameOrigin(req, publicUrl)).toBe(false);
    }
  });
});

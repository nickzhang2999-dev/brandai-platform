import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { middleware } from "../src/middleware";

// Use installed Next request/response behavior, without a server or database.
const requireWeb = createRequire(new URL("../next.config.mjs", import.meta.url));
const { NextRequest } = requireWeb("next/server");
const base = "https://novart-test.invalid";

describe("studio edge authentication responses", () => {
  it("allows the exact evidence endpoint to reach its bearer guard without opening adjacent internal routes", () => {
    const prefix = "/api/internal/inspiration-analysis/";
    const passed = middleware(new NextRequest(base + prefix + "jobs/job-1/workflow-evidence"));
    expect(passed.headers.get("x-middleware-next")).toBe("1");
    for (const suffix of ["jobs/job-1/workflow-evidence/extra", "jobs/job-1/other", "jobs/by-request/0123456789abcdef/workflow-evidence", "workflow-evidence", "jobs/" + "x".repeat(129) + "/workflow-evidence"]) {
      const response = middleware(new NextRequest(base + prefix + suffix));
      expect(response.status).toBe(401); expect(response.headers.get("x-middleware-next")).toBeNull();
    }
  });
  it.each(["/workflow", "/workflow/", "/workflow/assets", "/studio/draft", "/compare/api", "/compare/api/create"])(
    "returns JSON 401 for an anonymous API request to %s", async path => {
      const response = middleware(new NextRequest(base + path + "?projectId=boundary-test"));
      expect(response.status).toBe(401);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.json()).toEqual({ error: "Unauthorized" });
    },
  );

  it.each(["/studio", "/studio-editor", "/workflow-editor"])(
    "preserves page login redirects and callback queries for %s", path => {
      const response = middleware(new NextRequest(base + path + "?projectId=boundary-test"));
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin).toBe(base);
      expect(location.pathname).toBe("/login");
      expect(location.searchParams.get("callbackUrl")).toBe(path + "?projectId=boundary-test");
    },
  );

  it("leaves a session-bearing workflow request to the route's real session and membership guards", () => {
    const response = middleware(new NextRequest(base + "/workflow", {
      headers: { cookie: "authjs.session-token=boundary-test" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each(["/login", "/api/auth/csrf", "/api/health"])("preserves the public route %s", path => {
    const response = middleware(new NextRequest(base + path));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

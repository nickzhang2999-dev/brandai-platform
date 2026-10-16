import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { legacyStudioLocation, studioEditorHref } from "../../../apps/web/src/lib/studio-navigation";
import { middleware } from "../../../apps/web/src/middleware";
import { formatElapsed } from "../../../apps/web/src/lib/format-elapsed";

const requireWeb = createRequire(new URL("../../../apps/web/next.config.mjs", import.meta.url));
const { NextRequest } = requireWeb("next/server");
const base = "https://local-test.invalid";
const redirect = (path: string) => {
  const url = new URL(path, base);
  return legacyStudioLocation(url.pathname, url.searchParams);
};

describe("one Studio entry and safe legacy deep links", () => {
  it("keeps a project and its explicit brand when redirecting a legacy canvas", () => {
    expect(redirect("/workspace?workspaceId=w&project=p&taskId=t")).toBe("/studio-editor?workspaceId=w&taskId=t&projectId=p");
    expect(redirect("/workspace?projectId=new&project=old")).toBe("/studio-editor?projectId=new");
  });
  it("uses a project picker instead of an invalid projectless editor", () => {
    expect(redirect("/workspace")).toBe("/studio#/projects");
    expect(redirect("/workspaces/w/generate")).toBe("/studio?workspaceId=w#/projects");
    expect(studioEditorHref({ workspaceId: "w" })).toBe("/studio?workspaceId=w#/projects");
  });
  it.each([
    ["rules", "/brand-knowledge"], ["compliance", "/brand-knowledge"],
    ["assets", "/assets"], ["members", "/members"], ["projects", "/campaigns"],
  ])("maps the old %s page with explicit URL scope", (section, path) => {
    expect(redirect(`/workspaces/w/${section}?workspaceId=wrong`)).toBe(`${path}?workspaceId=w`);
  });
  it("retains scoped project paths and library version identifiers", () => {
    expect(redirect("/workspaces/w/projects/p")).toBe("/studio-editor?workspaceId=w&projectId=p");
    expect(redirect("/workspaces/w/generations/g/versions/v/edit")).toBe("/generated?workspaceId=w&generationId=g&versionId=v");
  });
  it.each(["/api/workspaces/w", "/admin/workspaces/w", "/workspaces/w/unknown", "/workspaces/w/assets/unknown", "/workspaces/%XX/assets"])("does not rewrite %s", path => {
    expect(redirect(path)).toBeNull();
  });
  it("encodes identifiers rather than allowing URL injection", () => {
    expect(studioEditorHref({ workspaceId: "w&admin=1", projectId: "p#external" })).toBe("/studio-editor?workspaceId=w%26admin%3D1&projectId=p%23external");
  });
  it("redirects before old shells mount and leaves authentication to the target", () => {
    const response = middleware(new NextRequest(base + "/workspace?project=p&workspaceId=w"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(base + "/studio-editor?workspaceId=w&projectId=p");
    const target = middleware(new NextRequest(response.headers.get("location")!));
    expect(new URL(target.headers.get("location")!).pathname).toBe("/login");
  });
  it("replaces spoofed workspace headers with the actual request URL", () => {
    for (const [suffix, expected] of [["?workspaceId=w", "w"], ["", null]] as const) {
      const response = middleware(new NextRequest(base + "/assets" + suffix, {
        headers: { cookie: "authjs.session-token=synthetic", "x-brandai-workspace-id": "foreign" },
      }));
      expect(response.headers.get("x-middleware-request-x-brandai-workspace-id")).toBe(expected);
    }
  });
  it("keeps elapsed formatting available without importing a UI route", () => {
    expect(formatElapsed(65000)).toBe("01:05");
    expect(formatElapsed(3661000)).toBe("1:01:01");
  });
});

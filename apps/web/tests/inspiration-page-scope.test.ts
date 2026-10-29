import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const React = createRequire(new URL("../package.json", import.meta.url))("react");
const f = vi.hoisted(() => ({ user: vi.fn(), cookie: vi.fn(), memberships: vi.fn(), workspaces: vi.fn(), workspace: vi.fn(), membership: vi.fn(), redirect: vi.fn() }));
vi.mock("../../../packages/db/src/index", () => ({ prisma: {
  membership: { findMany: f.memberships, findUnique: f.membership },
  brandWorkspace: { findMany: f.workspaces, findUnique: f.workspace },
} }));
vi.mock("@/lib/api", () => ({ requireUser: f.user,
  ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
}));
vi.mock("../node_modules/next/headers.js", () => ({ cookies: async () => ({ get: f.cookie }) }));
vi.mock("../node_modules/next/navigation.js", () => ({ redirect: f.redirect }));
vi.mock("../src/app/inspiration/inspiration-client", () => ({ default: () => null }));
import { ApiException } from "../src/lib/api";
import InspirationPage from "../src/app/inspiration/page";
import InspirationClient from "../src/app/inspiration/inspiration-client";

type Element = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): Element[] {
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...React.Children.toArray(element.props.children).flatMap(elements)];
}
const page = (params: Record<string, string | string[] | undefined> = {}) => InspirationPage({ searchParams: Promise.resolve(params) });
const client = (root: unknown) => elements(root).find(element => element.type === InspirationClient);
const returnLink = (root: unknown) => elements(root).find(element => element.type === "a");
const alert = (root: unknown) => elements(root).find(element => element.props.role === "alert");

beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal("React", React);
  f.user.mockResolvedValue({ id: "current-user", name: "Current user" });
  f.cookie.mockReturnValue({ value: "owned-brand" });
  f.memberships.mockResolvedValue([{ workspaceId: "shared-brand", role: "VIEWER" }]);
  f.workspaces.mockResolvedValue([
    { id: "owned-brand", name: "Owned brand", ownerId: "current-user" },
    { id: "shared-brand", name: "Shared brand", ownerId: "another-user" },
  ]);
  f.workspace.mockImplementation(async ({ where }: { where: { id: string } }) => ({ id: where.id, name: "Resolved brand", ownerId: where.id === "owned-brand" ? "current-user" : "another-user" }));
  f.membership.mockResolvedValue({ role: "VIEWER" });
  f.redirect.mockImplementation((url: string) => { throw new Error("REDIRECT:" + url); });
});
afterEach(() => vi.unstubAllGlobals());

describe("standalone inspiration page session and workspace boundary", () => {
  it("keeps the explicit member brand over a different preference cookie and returns to the same Studio", async () => {
    const root = await page({ workspaceId: "shared-brand" });
    expect(client(root)?.props.wsId).toBe("shared-brand");
    expect(returnLink(root)?.props.href).toBe("/studio?workspaceId=shared-brand");
    expect(root.props["data-workspace-id"]).toBe("shared-brand");
    expect(f.membership).toHaveBeenCalledWith({ where: { userId_workspaceId: { userId: "current-user", workspaceId: "shared-brand" } }, select: { role: true } });
    expect(f.cookie).not.toHaveBeenCalled();
  });

  it("preserves the allowed deep-link query through an anonymous login redirect", async () => {
    f.user.mockRejectedValue(new ApiException(401, "Unauthorized"));
    const params = { workspaceId: "shared-brand", conversationId: "conversation-1", q: "包装 + 标签 & 字体", kind: "reference", industry: "food-beverage", medium: "packaging", task: "series", ignored: "discard" };
    await expect(page(params)).rejects.toThrow("REDIRECT:");
    const target = new URL(f.redirect.mock.calls[0][0], "https://app.invalid");
    const callback = new URL(target.searchParams.get("callbackUrl")!, "https://app.invalid");
    expect(target.pathname).toBe("/login");
    expect(callback.pathname).toBe("/inspiration");
    expect(Object.fromEntries(callback.searchParams)).toEqual({ workspaceId: params.workspaceId, conversationId: params.conversationId, q: params.q, kind: params.kind, industry: params.industry, medium: params.medium, task: params.task });
    expect(f.workspaces).not.toHaveBeenCalled();
    expect(f.workspace).not.toHaveBeenCalled();
  });

  it("denies a pinned inaccessible brand without rendering a fallback or exposing another brand", async () => {
    const root = await page({ workspaceId: "foreign-brand" });
    expect(client(root)).toBeUndefined();
    expect(alert(root)).toBeDefined();
    expect(returnLink(root)?.props.href).toBe("/studio");
    expect(f.workspace).not.toHaveBeenCalled();
    expect(f.cookie).not.toHaveBeenCalled();
  });

  it("rejects repeated workspace parameters before a first-value or cookie fallback is possible", async () => {
    const root = await page({ workspaceId: ["shared-brand", "foreign-brand"] });
    expect(client(root)).toBeUndefined();
    expect(alert(root)?.props.children).toContain("品牌参数无效");
    expect(f.user).not.toHaveBeenCalled();
    expect(f.workspaces).not.toHaveBeenCalled();
  });

  it.each(["", "x".repeat(129)])("rejects malformed explicit workspace IDs without resolving a fallback", async workspaceId => {
    const root = await page({ workspaceId });
    expect(client(root)).toBeUndefined();
    expect(alert(root)).toBeDefined();
    expect(f.workspaces).not.toHaveBeenCalled();
    expect(f.cookie).not.toHaveBeenCalled();
  });

  it("uses the validated session workspace when no explicit workspace was supplied", async () => {
    const root = await page();
    expect(client(root)?.props.wsId).toBe("owned-brand");
    expect(returnLink(root)?.props.href).toBe("/studio?workspaceId=owned-brand");
    expect(f.membership).not.toHaveBeenCalled();
  });

  it("rejects a membership revoked between session resolution and the page role check", async () => {
    f.membership.mockResolvedValue(null);
    const root = await page({ workspaceId: "shared-brand" });
    expect(client(root)).toBeUndefined();
    expect(alert(root)).toBeDefined();
    expect(returnLink(root)?.props.href).toBe("/studio");
  });

  it("keeps a disabled user out before any workspace read", async () => {
    f.user.mockRejectedValue(new ApiException(403, "账号已被停用"));
    const root = await page({ workspaceId: "shared-brand" });
    expect(client(root)).toBeUndefined();
    expect(alert(root)?.props.children).toBe("账号已被停用");
    expect(f.memberships).not.toHaveBeenCalled();
    expect(f.workspaces).not.toHaveBeenCalled();
  });

  it("offers a Studio return for an account with no brand instead of creating one on GET", async () => {
    f.memberships.mockResolvedValue([]); f.workspaces.mockResolvedValue([]);
    const root = await page();
    expect(client(root)).toBeUndefined();
    expect(alert(root)?.props.children).toBe("请先创建或选择品牌。");
    expect(returnLink(root)?.props.href).toBe("/studio");
    expect(f.workspace).not.toHaveBeenCalled();
  });

  it("does not render internal exception details to the user", async () => {
    f.workspaces.mockRejectedValue(new Error("private database diagnostic"));
    const root = await page({ workspaceId: "shared-brand" });
    expect(client(root)).toBeUndefined();
    expect(alert(root)?.props.children).toBe("无法打开设计灵感，请从工作台重新选择品牌。");
  });
});

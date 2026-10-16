import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const React = createRequire(new URL("../../../apps/web/package.json", import.meta.url))("react");
const f = vi.hoisted(() => ({ auth: vi.fn(), user: vi.fn(), workspace: vi.fn(), membership: vi.fn(), fallback: vi.fn(), header: vi.fn() }));
vi.mock("@/auth", () => ({ auth: f.auth }));
vi.mock("../../db/src/index", () => ({ prisma: { user: { findUnique: f.user }, brandWorkspace: { findFirst: f.workspace }, membership: { findUnique: f.membership } } }));
vi.mock("../../../apps/web/node_modules/next/headers.js", () => ({ cookies: async () => ({ get: () => ({ value: "cookie-brand" }) }), headers: async () => ({ get: f.header }) }));
vi.mock("../../../apps/web/node_modules/next/navigation.js", () => ({ redirect: () => { throw new Error("LOGIN"); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/lib/admin", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/brandai", () => ({ getOrCreateActiveBrand: f.fallback }));
vi.mock("@/lib/brand-cookie", () => ({ ACTIVE_BRAND_COOKIE: "brandai-active-brand" }));
vi.mock("../../../apps/web/src/app/(brandai)/brand-context", () => ({ BrandProvider: () => null }));
vi.mock("../../../apps/web/src/app/(brandai)/brand-sidebar", () => ({ BrandSidebar: () => null }));
import Layout from "../../../apps/web/src/app/(brandai)/layout";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("React", React);
  f.auth.mockResolvedValue({ user: { id: "u" } });
  f.user.mockResolvedValue({ isActive: true, name: "Fixture" });
  f.header.mockReturnValue("url-brand");
  f.workspace.mockResolvedValue({ id: "url-brand", name: "Brand", ownerId: "u" });
  f.fallback.mockResolvedValue({ id: "cookie-brand", name: "Cookie Brand" });
});
describe("server brand scope for canonical deep links", () => {
  it("uses the URL brand instead of the stale cookie for its owner", async () => {
    const element = await Layout({ children: null });
    expect(element.props.value.wsId).toBe("url-brand");
    expect(f.fallback).not.toHaveBeenCalled();
    expect(f.membership).not.toHaveBeenCalled();
  });
  it("allows an actual member of the requested brand", async () => {
    f.workspace.mockResolvedValue({ id: "url-brand", name: "Brand", ownerId: "owner" });
    f.membership.mockResolvedValue({ id: "membership" });
    expect((await Layout({ children: null })).props.value.wsId).toBe("url-brand");
    expect(f.membership).toHaveBeenCalledWith({ where: { userId_workspaceId: { userId: "u", workspaceId: "url-brand" } }, select: { id: true } });
  });
  it("does not silently substitute another brand when explicit access is denied", async () => {
    f.workspace.mockResolvedValue({ id: "url-brand", name: "Private", ownerId: "other" });
    f.membership.mockResolvedValue(null);
    await expect(Layout({ children: null })).rejects.toThrow("NOT_FOUND");
    expect(f.fallback).not.toHaveBeenCalled();
  });
  it("rejects a deleted brand and does not create a replacement", async () => {
    f.workspace.mockResolvedValue(null);
    await expect(Layout({ children: null })).rejects.toThrow("NOT_FOUND");
    expect(f.fallback).not.toHaveBeenCalled();
  });
  it("keeps validated cookie fallback for ordinary navigation", async () => {
    f.header.mockReturnValue(null);
    expect((await Layout({ children: null })).props.value.wsId).toBe("cookie-brand");
    expect(f.fallback).toHaveBeenCalledWith("u", "cookie-brand");
  });
  it("rejects disabled accounts before any brand lookup", async () => {
    f.user.mockResolvedValue({ isActive: false });
    await expect(Layout({ children: null })).rejects.toThrow("LOGIN");
    expect(f.workspace).not.toHaveBeenCalled();
  });
});

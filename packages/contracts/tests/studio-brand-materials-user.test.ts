import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock("../../../apps/web/src/lib/api", () => ({ requireUser: f.user, ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { requireStudioBrandMaterialUser } from "../../../apps/web/src/lib/studio-brand-materials-user";
beforeEach(() => { f.user.mockReset(); f.user.mockResolvedValue({ id: "authenticated" }); });
describe("brand material cookie authority and tab identity", () => {
  it("allows legacy no-hint requests and the matching authenticated hint", async () => {
    expect((await requireStudioBrandMaterialUser(new Request("http://127.0.0.1"))).id).toBe("authenticated");
    expect((await requireStudioBrandMaterialUser(new Request("http://127.0.0.1", { headers: { "X-Novart-User": "authenticated" } }))).id).toBe("authenticated");
  });
  it("rejects an old tab after account changes without treating the hint as authentication", async () => {
    await expect(requireStudioBrandMaterialUser(new Request("http://127.0.0.1", { headers: { "X-Novart-User": "previous" } }))).rejects.toMatchObject({ status: 409 });
    f.user.mockRejectedValueOnce({ status: 401 });
    await expect(requireStudioBrandMaterialUser(new Request("http://127.0.0.1", { headers: { "X-Novart-User": "authenticated" } }))).rejects.toMatchObject({ status: 401 });
  });
});

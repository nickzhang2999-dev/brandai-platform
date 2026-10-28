import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ requireUser: vi.fn() }));
vi.mock("@/lib/api", () => ({ requireUser: f.requireUser, ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { readWritingUpload, writingRouteScope, writingFailure } from "@/lib/studio-writing-http";
import { StudioWritingGenerateInput } from "@brandai/contracts";
const context = { params: Promise.resolve({ wsId: "w", projectId: "p" }) };
afterEach(() => vi.resetAllMocks());
describe("writing HTTP trust and upload boundaries", () => {
  it("pins requests to the authenticated user, enforces same origin for writes, and allows cookie-scoped image reads", async () => {
    f.requireUser.mockResolvedValue({ id: "current" });
    const req = (headers: HeadersInit) => new Request("https://nova.invalid/api/workspaces/w/projects/p/studio-writing", { headers });
    await expect(writingRouteScope(req({ "X-Novart-User": "old-account" }), context)).rejects.toMatchObject({ status: 409 });
    await expect(writingRouteScope(req({ "X-Novart-User": "current", Origin: "https://attacker.invalid" }), context, true)).rejects.toMatchObject({ status: 403 });
    expect(await writingRouteScope(req({ "X-Novart-User": "current", Origin: "https://nova.invalid" }), context, true)).toEqual({ workspaceId: "w", projectId: "p", userId: "current" });
    expect((await writingRouteScope(req({}), context, false, true)).userId).toBe("current");
  });
  it("handles only one named file and one UUID without file I/O, OCR or a model call", async () => {
    const form = new FormData(); form.set("mutationId", randomUUID()); form.set("file", new Blob(["reference data"], { type: "text/plain" }), "ref.txt");
    const output = await readWritingUpload(new Request("https://nova.invalid", { method: "POST", body: form }));
    expect(output.name).toBe("ref.txt"); expect(output.body.toString()).toBe("reference data");
    form.append("file", new Blob(["extra"]), "extra.txt");
    await expect(readWritingUpload(new Request("https://nova.invalid", { method: "POST", body: form }))).rejects.toMatchObject({ status: 422 });
  });
  it("rejects advertised and actual oversize bodies, truncated multipart and unexpected fields", async () => {
    await expect(readWritingUpload(new Request("https://nova.invalid", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": String(20 * 1024 * 1024) }, body: "" }))).rejects.toMatchObject({ status: 413 });
    await expect(readWritingUpload(new Request("https://nova.invalid", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" }, body: new Uint8Array(10 * 1024 * 1024 + 65537) }))).rejects.toMatchObject({ status: 413 });
    await expect(readWritingUpload(new Request("https://nova.invalid", { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=x" }, body: "malformed" }))).rejects.toMatchObject({ status: 422 });
    const form = new FormData(); form.set("mutationId", randomUUID()); form.set("file", new Blob(["data"]), "ref.txt"); form.set("apiKey", "forbidden");
    await expect(readWritingUpload(new Request("https://nova.invalid", { method: "POST", body: form }))).rejects.toMatchObject({ status: 422 });
  });
  it("never returns raw validation inputs, exception strings or database details", async () => {
    const response = writingFailure(new Error("secret connection string")); expect(response.status).toBe(503); expect(await response.text()).not.toContain("secret");
    const parsed = StudioWritingGenerateInput.safeParse({ apiKey: "private-input" });
    if (parsed.success) throw new Error("invalid fixture");
    const rejected = writingFailure(parsed.error); expect(rejected.status).toBe(422); expect(await rejected.text()).not.toContain("private-input");
  });
});

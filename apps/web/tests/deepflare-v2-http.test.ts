import { beforeEach, describe, expect, it, vi } from "vitest";
const stubs = vi.hoisted(() => ({ user: vi.fn(), create: vi.fn(), read: vi.fn(), command: vi.fn() }));
vi.mock("@/lib/api", () => ({
  requireUser: stubs.user,
  ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } },
}));
vi.mock("../src/lib/deepflare-v2/service", () => ({
  createWorkOrder: stubs.create, readWorkOrder: stubs.read, commandWorkOrder: stubs.command,
  V2AccessError: class extends Error { constructor(public status: number, message: string) { super(message); } },
}));
import { handleV2WorkOrder } from "../src/lib/deepflare-v2/http";

describe("2.0 HTTP boundary (service mocked, SQL has separate integration coverage)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("DEEPFLARE_V2_ENABLED", "1");
    vi.stubEnv("DEEPFLARE_V2_WORKSPACE_IDS", "brand");
    vi.stubEnv("AUTH_URL", "http://localhost:3000");
    stubs.user.mockResolvedValue({ id: "user" });
    stubs.create.mockResolvedValue({ executionAvailable: false });
  });
  const context = () => ({ params: Promise.resolve({ wsId: "brand", projectId: "project" }) });
  const request = (headers: Record<string, string> = {}, body = "{}") =>
    new Request("http://localhost:3000/api/v2/work-orders", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers }, body });
  it("disabled routes do not touch authentication or SQL", async () => {
    vi.stubEnv("DEEPFLARE_V2_ENABLED", "0");
    expect((await handleV2WorkOrder(request(), context())).status).toBe(404);
    expect(stubs.user).not.toHaveBeenCalled();
    expect(stubs.create).not.toHaveBeenCalled();
  });
  it("rejects cross-origin writes", async () => {
    expect((await handleV2WorkOrder(request({ origin: "https://other.example" }), context())).status).toBe(403);
    expect(stubs.create).not.toHaveBeenCalled();
  });
  it("rejects old-tab users after account switching", async () => {
    expect((await handleV2WorkOrder(request({ "X-Novart-User": "other" }), context())).status).toBe(409);
    expect(stubs.create).not.toHaveBeenCalled();
  });
  it("bounds and validates request JSON", async () => {
    expect((await handleV2WorkOrder(request({}, "x".repeat(65537)), context())).status).toBe(413);
    expect((await handleV2WorkOrder(request({}, "{broken"), context())).status).toBe(400);
    expect(stubs.create).not.toHaveBeenCalled();
  });
  it("forwards only the authenticated actor and route scope", async () => {
    const response = await handleV2WorkOrder(request(), context());
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(stubs.create).toHaveBeenCalledWith({ workspaceId: "brand", projectId: "project" }, "user", {});
    expect(await response.json()).toEqual({ executionAvailable: false });
  });
  it("reads persistent state by work-order ID", async () => {
    stubs.read.mockResolvedValue({ id: "order" });
    const response = await handleV2WorkOrder(new Request("http://localhost:3000/api/v2/order"), {
      params: Promise.resolve({ wsId: "brand", projectId: "project", workOrderId: "order" }),
    });
    expect(response.status).toBe(200);
    expect(stubs.read).toHaveBeenCalledWith({ workspaceId: "brand", projectId: "project" }, "user", "order");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../../db/src/index", () => ({ prisma: {} }));
vi.mock("../../../apps/web/src/auth", () => ({ auth: vi.fn() }));
import { ApiException, handleError } from "../../../apps/web/src/lib/api";

afterEach(() => vi.restoreAllMocks());

describe("API internal error boundary", () => {
  it.each([
    new Error("synthetic private database diagnostic"),
    new ApiException(500, "synthetic private server diagnostic", { stack: "private stack" }),
    { query: "synthetic internal query", toString() { throw new Error("must not stringify"); } },
    "synthetic private thrown text",
    null,
  ])("returns only a safe response and correlates the original server diagnostic", async original => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = handleError(original);
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "InternalError", requestId: expect.any(String) });
    expect(body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("[api-error]", { requestId: body.requestId, error: original });
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("assigns independent IDs to repeated failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const original = new Error("repeat");
    const first = await handleError(original).json();
    const second = await handleError(original).json();
    expect(second.requestId).not.toBe(first.requestId);
  });

  it("preserves field-level validation and expected client errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const invalid = z.object({ name: z.string().min(1) }).safeParse({ name: "" });
    if (invalid.success) throw new Error("fixture must be invalid");
    const validation = handleError(invalid.error);
    expect(validation.status).toBe(422);
    expect(await validation.json()).toMatchObject({ error: "ValidationError", details: { fieldErrors: { name: expect.any(Array) } } });
    const forbidden = handleError(new ApiException(403, "Forbidden"));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "Forbidden" });
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps explicitly authored availability messages actionable", async () => {
    const response = handleError(new ApiException(503, "对象存储尚未配置。"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "对象存储尚未配置。" });
  });
});

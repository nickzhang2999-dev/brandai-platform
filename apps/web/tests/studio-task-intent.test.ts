import { describe, expect, it, vi } from "vitest";
vi.mock("../src/lib/api", () => ({ ApiException: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { studioTaskIntent } from "../src/lib/studio-task-intent";

const kinds = [
  ["taskId", "STUDIO_UPLOAD"],
  ["requestId", "STUDIO_GENERATION"],
  ["layerRequestId", "STUDIO_DECOMPOSITION"],
] as const;
function invalid(query: URLSearchParams) {
  expect(() => studioTaskIntent(query)).toThrow();
  try { studioTaskIntent(query); } catch (error) { expect(error).toMatchObject({ status: 422 }); }
}

describe("mutually exclusive product task deep-link intent", () => {
  it("has no task intent when only workspace/project navigation parameters are present", () => {
    expect(studioTaskIntent(new URLSearchParams())).toBeUndefined();
    expect(studioTaskIntent(new URLSearchParams({ workspaceId: "w", projectId: "p" }))).toBeUndefined();
  });
  it.each(kinds)("maps %s to %s without granting task ownership", (parameter, kind) => {
    expect(studioTaskIntent(new URLSearchParams({ workspaceId: "w", projectId: "p", [parameter]: "Existing_Task-123" }))).toEqual({ kind, id: "Existing_Task-123" });
    expect(studioTaskIntent(new URLSearchParams({ [parameter]: "a".repeat(128) }))).toEqual({ kind, id: "a".repeat(128) });
  });
  it.each(kinds)("rejects duplicated %s even when both values agree", (parameter) => {
    invalid(new URLSearchParams([[parameter, "same"], [parameter, "same"]]));
    invalid(new URLSearchParams([[parameter, "first"], [parameter, "second"]]));
  });
  it.each([
    ["taskId", "requestId"], ["taskId", "layerRequestId"], ["requestId", "layerRequestId"],
  ])("rejects simultaneous %s and %s rather than choosing whichever appears first", (first, second) => {
    invalid(new URLSearchParams([[first!, "one"], [second!, "two"]]));
    invalid(new URLSearchParams([[second!, "two"], [first!, "one"]]));
    invalid(new URLSearchParams([[first!, "one"], [second!, ""]]));
  });
  it("rejects all three task intents together", () => {
    invalid(new URLSearchParams({ taskId: "upload", requestId: "generation", layerRequestId: "layers" }));
  });
  it.each(kinds)("rejects empty, malformed or hostile IDs in %s", (parameter) => {
    for (const value of ["", " ", " leading", "trailing ", "x/y", "..", "x%2fy", "x?token=y", "x#fragment", "<script>", "a\n", "a\u0000", "中文", "a".repeat(129)]) {
      invalid(new URLSearchParams({ [parameter]: value }));
    }
    invalid(new URLSearchParams(`${parameter}=%2Fapi%2Fprivate`));
  });
});

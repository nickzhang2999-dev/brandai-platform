/**
 * REGRESSION LOCK for the root cause.
 *
 * The bug: FastAPI serialized unset optionals as explicit `null`; the shared
 * Zod schemas use `.optional()` which accepts `undefined` but REJECTS `null`.
 * These tests pin that semantic so nobody "fixes" it by loosening contracts
 * instead of keeping the AI service's response_model_exclude_none=True.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Evidence } from "../src/index";

describe("Zod .optional() ⊥ null — the contract invariant", () => {
  it("an omitted optional key is valid", () => {
    expect(Evidence.safeParse({ assetId: "a1" }).success).toBe(true);
  });

  it("an explicit null on an optional field is INVALID (the bug shape)", () => {
    const r = Evidence.safeParse({
      assetId: "a1",
      bbox: null,
      note: null,
      thumbnailUrl: null,
    });
    expect(r.success).toBe(false);
  });

  it("the fix shape (key absent) round-trips", () => {
    expect(
      Evidence.safeParse({ assetId: "a1", note: "mock evidence" }).success,
    ).toBe(true);
  });
});

describe("no captured AI fixture contains a null anywhere", () => {
  const dir = join(__dirname, "fixtures");

  function nulls(v: unknown, p = "$"): string[] {
    if (v === null) return [p];
    if (Array.isArray(v)) return v.flatMap((x, i) => nulls(x, `${p}[${i}]`));
    if (v && typeof v === "object")
      return Object.entries(v).flatMap(([k, x]) => nulls(x, `${p}.${k}`));
    return [];
  }

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    it(`${file} is null-free`, () => {
      const hits = nulls(
        JSON.parse(readFileSync(join(dir, file), "utf8")),
      );
      expect(hits, `nulls at ${hits.join(", ")}`).toEqual([]);
    });
  }
});

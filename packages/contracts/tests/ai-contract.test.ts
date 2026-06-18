/**
 * CROSS-STACK CONTRACT TEST.
 *
 * Fixtures under tests/fixtures/*.json are *real* responses captured from
 * the Python FastAPI AI service. This proves the FROZEN Zod schemas accept
 * exactly what the AI service actually emits — the seam where the original
 * null-vs-optional production bug lived.
 *
 * Regenerate fixtures with: pnpm test:fixtures (see docs/TESTING.md).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ComplianceCheckResponse,
  EditResponse,
  GenerateResponse,
  IngestWebsiteResponse,
  RecognizeResponse,
} from "../src/index";

const load = (n: string) =>
  JSON.parse(
    readFileSync(join(__dirname, "fixtures", `${n}.json`), "utf8"),
  );

const cases = [
  ["ingest", IngestWebsiteResponse],
  ["recognize", RecognizeResponse],
  ["generate", GenerateResponse],
  ["edit", EditResponse],
  ["compliance", ComplianceCheckResponse],
] as const;

describe("AI service output ⊨ frozen Zod contracts", () => {
  for (const [name, schema] of cases) {
    it(`${name}.json parses cleanly`, () => {
      const parsed = schema.safeParse(load(name));
      if (!parsed.success) {
        throw new Error(
          `${name} violates contract:\n` +
            JSON.stringify(parsed.error.format(), null, 2),
        );
      }
      expect(parsed.success).toBe(true);
    });
  }

  it("recognize evidence chain is present (每条规则可溯源)", () => {
    const d = RecognizeResponse.parse(load("recognize"));
    expect(d.rules.length).toBeGreaterThan(0);
    for (const r of d.rules) expect(r.evidence.length).toBeGreaterThan(0);
  });

  it("compliance flags the absolute-claim risk", () => {
    const d = ComplianceCheckResponse.parse(load("compliance"));
    expect(["RISK", "FORBIDDEN"]).toContain(d.report.overall);
  });
});

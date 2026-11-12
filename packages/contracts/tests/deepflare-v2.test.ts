import { describe, it, expect } from "vitest";
import fixtures from "./protocol-fixtures/deepflare-v2.json";
import { DeepFlareV2CreateInput, DeepFlareV2CommandInput } from "../src/deepflare-v2";
describe("2.0 shared Zod/Pydantic fixtures", () => {
  for (const fixture of fixtures) it(fixture.name, () => {
    const schema = fixture.schema === "create" ? DeepFlareV2CreateInput : DeepFlareV2CommandInput;
    expect(schema.safeParse(fixture.value).success).toBe(fixture.valid);
  });
});

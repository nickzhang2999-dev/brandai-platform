import { describe, expect, it } from "vitest";
import { ComplianceCheckRequest, GenerateRequest, IngestWebsiteRequest, RecognizeRequest, DescribeRequest, ParseManualRequest, SummarizeRequest, EditRequest } from "../src/ai";

const generation = { sceneType: "ECOM_MAIN", sellingPoint: "A poster", scene: "", brandRules: [] };
const compliance = { termLib: [] };

describe("internal product provider retry policy", () => {
  it("is omitted for legacy callers and preserved only for the supported opt-in", () => {
    expect(GenerateRequest.parse(generation)).not.toHaveProperty("providerRetryPolicy");
    expect(ComplianceCheckRequest.parse(compliance)).not.toHaveProperty("providerRetryPolicy");
    expect(GenerateRequest.parse({ ...generation, providerRetryPolicy: "never" }).providerRetryPolicy).toBe("never");
    expect(ComplianceCheckRequest.parse({ ...compliance, providerRetryPolicy: "never" }).providerRetryPolicy).toBe("never");
  });

  it.each([null, "", "always", "default", 1, true, {}])("rejects unsupported policy %j with Python-equivalent null semantics", value => {
    expect(GenerateRequest.safeParse({ ...generation, providerRetryPolicy: value }).success).toBe(false);
    expect(ComplianceCheckRequest.safeParse({ ...compliance, providerRetryPolicy: value }).success).toBe(false);
  });
});

it.each([
  [IngestWebsiteRequest, { url: "https://example.invalid" }],
  [RecognizeRequest, { assets: [{ id: "fixture", url: "https://example.invalid/image.png" }] }],
  [DescribeRequest, { url: "https://example.invalid/image.png" }],
  [ParseManualRequest, { url: "https://example.invalid/manual.pdf" }],
  [SummarizeRequest, { mode: "brief_decompose", text: "poster" }],
  [EditRequest, { imageUrl: "https://example.invalid/image.png", op: "RESIZE", payload: {} }],
] as const)("legacy schema accepts only omitted or never retry policy", (schema, payload) => {
  expect(schema.parse(payload)).not.toHaveProperty("providerRetryPolicy");
  expect(schema.parse({ ...payload, providerRetryPolicy: "never" }).providerRetryPolicy).toBe("never");
  for (const value of [null, "always", true]) expect(schema.safeParse({ ...payload, providerRetryPolicy: value }).success).toBe(false);
});

import { describe, expect, it } from "vitest";
import { ComplianceCheckRequest, GenerateRequest } from "../src/ai";

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

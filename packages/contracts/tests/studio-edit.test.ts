import { describe, expect, it } from "vitest";
import { StudioEditRequest, StudioEditResponse } from "../src/studio-edit";

const image = "data:image/png;base64,YWJjZA==";
const request = () => ({ imageUrl: image, generation: { sceneType: "SOCIAL_POSTER", sellingPoint: "Edit the background", scene: "", brandRules: [], providerRetryPolicy: "never", versionCount: 1, targets: [{ key: "wide", label: "Wide", width: 2560, height: 1440 }] } });
describe("internal whole-image edit transport", () => {
  it("requires one explicit output and keeps the server's no-retry policy", () => {
    expect(StudioEditRequest.parse(request()).generation.targets).toHaveLength(1);
    expect(StudioEditRequest.parse(request()).generation.providerRetryPolicy).toBe("never");
  });
  it.each([null, "always", undefined])("rejects a missing or downgraded retry policy %s", value => {
    const body = request(); (body.generation as any).providerRetryPolicy = value;
    expect(StudioEditRequest.safeParse(body).success).toBe(false);
  });
  it.each(["https://image.invalid/a.png", "data:image/svg+xml;base64,YWJjZA==", "data:image/png;base64,YWJjZB==", "data:image/png;base64,YWJjZA="])("rejects unbounded/external or malformed input %s", imageUrl => {
    expect(StudioEditRequest.safeParse({ ...request(), imageUrl }).success).toBe(false);
    const body: any = request(); body.generation.aiConstraints = { referenceImages: [{ url: imageUrl, polarity: "negative", source: "example" }] };
    expect(StudioEditRequest.safeParse(body).success).toBe(false);
  });
  it("rejects mask scope, fan-out and source-plus-reference overflow instead of discarding them", () => {
    expect(StudioEditRequest.safeParse({ ...request(), mask: image }).success).toBe(false);
    const body: any = request(); body.generation.targets.push(body.generation.targets[0]);
    expect(StudioEditRequest.safeParse(body).success).toBe(false);
    body.generation.targets.pop(); body.generation.versionCount = 2;
    expect(StudioEditRequest.safeParse(body).success).toBe(false);
    body.generation.versionCount = 1; body.generation.aiConstraints = { referenceImages: Array.from({ length: 16 }, (_, n) => ({ url: image, source: String(n), polarity: "positive" })) };
    expect(StudioEditRequest.safeParse(body).success).toBe(false);
    body.generation.aiConstraints.referenceImages.pop(); expect(StudioEditRequest.safeParse(body).success).toBe(true);
  });
  it("returns exactly one ordinary generation version", () => {
    const version = { imageUrl: image, width: 2560, height: 1440, params: {} };
    expect(StudioEditResponse.safeParse({ versions: [version] }).success).toBe(true);
    expect(StudioEditResponse.safeParse({ versions: [] }).success).toBe(false);
    expect(StudioEditResponse.safeParse({ versions: [version, version] }).success).toBe(false);
  });
});

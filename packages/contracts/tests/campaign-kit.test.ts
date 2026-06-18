/** E8 — CampaignKitInput contract shape. */
import { describe, expect, it } from "vitest";
import { CampaignKitInput } from "../src/api";

describe("CampaignKitInput", () => {
  const base = {
    projectId: "p1",
    sellingPoint: "手工冷萃",
    scene: "门店暖光",
    scenes: ["ECOM_MAIN", "SOCIAL_POSTER"],
    targets: [{ key: "ecom_main", label: "电商主图", width: 1024, height: 1024 }],
  };

  it("accepts a valid multi-scene multi-size kit and defaults textMode", () => {
    const r = CampaignKitInput.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.textMode).toBe("direct");
  });

  it("requires at least one scene and one target", () => {
    expect(CampaignKitInput.safeParse({ ...base, scenes: [] }).success).toBe(false);
    expect(CampaignKitInput.safeParse({ ...base, targets: [] }).success).toBe(false);
  });

  it("rejects an unknown scene type and caps scenes at 5", () => {
    expect(CampaignKitInput.safeParse({ ...base, scenes: ["NOPE"] }).success).toBe(false);
    expect(
      CampaignKitInput.safeParse({
        ...base,
        scenes: ["ECOM_MAIN", "SCENE", "SOCIAL_POSTER", "CAMPAIGN_KV", "SELLING_POINT", "ECOM_MAIN"],
      }).success,
    ).toBe(false);
  });
});

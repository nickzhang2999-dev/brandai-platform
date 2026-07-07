/** Admin plan-quota editing contract — the /admin/plans write boundary. */
import { describe, expect, it } from "vitest";
import { AdminUpdatePlanInput } from "../src/admin";

const base = {
  name: "Starter",
  dailyGenerationLimit: 30,
  monthlyGenerationQuota: 600,
  maxWorkspaces: 1,
};

describe("AdminUpdatePlanInput", () => {
  it("accepts a normal finite quota update", () => {
    expect(AdminUpdatePlanInput.parse(base)).toEqual(base);
  });

  it("accepts -1 (unlimited) on every quota field", () => {
    const unlimited = {
      name: "Enterprise",
      dailyGenerationLimit: -1,
      monthlyGenerationQuota: -1,
      maxWorkspaces: -1,
    };
    expect(AdminUpdatePlanInput.parse(unlimited)).toEqual(unlimited);
  });

  it("rejects values below -1 (only -1 means unlimited)", () => {
    expect(() =>
      AdminUpdatePlanInput.parse({ ...base, dailyGenerationLimit: -2 }),
    ).toThrow();
  });

  it("rejects non-integer quotas", () => {
    expect(() =>
      AdminUpdatePlanInput.parse({ ...base, monthlyGenerationQuota: 30.5 }),
    ).toThrow();
  });

  it("rejects an empty / whitespace-only name", () => {
    expect(() => AdminUpdatePlanInput.parse({ ...base, name: "   " })).toThrow();
  });

  it("trims the name", () => {
    expect(AdminUpdatePlanInput.parse({ ...base, name: "  Pro  " }).name).toBe(
      "Pro",
    );
  });
});

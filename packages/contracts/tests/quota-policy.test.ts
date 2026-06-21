/** K1 — pure quota policy math (no DB). */
import { describe, expect, it } from "vitest";
import {
  UNLIMITED,
  canCreateWorkspace,
  dedupedSceneCount,
  evaluateGenerationQuota,
  isUnlimited,
} from "../src/quota-policy";

const UNLIMITED_PLAN = {
  dailyGenerationLimit: UNLIMITED,
  monthlyGenerationQuota: UNLIMITED,
  maxWorkspaces: UNLIMITED,
};

describe("evaluateGenerationQuota", () => {
  it("default/owner/admin unlimited plan ALWAYS passes (phase-1 not regressed)", () => {
    // Even with absurd usage, unlimited never blocks.
    const d = evaluateGenerationQuota(
      UNLIMITED_PLAN,
      { dailyUsed: 9999, periodUsed: 9999 },
      12,
    );
    expect(d.ok).toBe(true);
    expect(d.reason).toBeUndefined();
  });

  it("a finite plan blocks once the daily limit would be exceeded", () => {
    const plan = {
      dailyGenerationLimit: 5,
      monthlyGenerationQuota: 100,
      maxWorkspaces: 1,
    };
    expect(
      evaluateGenerationQuota(plan, { dailyUsed: 4, periodUsed: 4 }, 1).ok,
    ).toBe(true);
    const d = evaluateGenerationQuota(plan, { dailyUsed: 5, periodUsed: 5 }, 1);
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("DAILY_LIMIT");
    expect(d.limit).toBe(5);
    expect(d.used).toBe(5);
    expect(d.requested).toBe(1);
  });

  it("a finite plan blocks once the period quota would be exceeded", () => {
    const plan = {
      dailyGenerationLimit: UNLIMITED,
      monthlyGenerationQuota: 10,
      maxWorkspaces: 1,
    };
    const d = evaluateGenerationQuota(plan, { dailyUsed: 0, periodUsed: 10 }, 1);
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("PERIOD_QUOTA");
  });

  it("checks the WHOLE requested count atomically (no half kit)", () => {
    const plan = {
      dailyGenerationLimit: 100,
      monthlyGenerationQuota: 10,
      maxWorkspaces: 1,
    };
    // 8 used + 3 requested = 11 > 10 → blocked as a set.
    expect(
      evaluateGenerationQuota(plan, { dailyUsed: 8, periodUsed: 8 }, 3).ok,
    ).toBe(false);
    // 7 used + 3 requested = 10 == 10 → fits exactly.
    expect(
      evaluateGenerationQuota(plan, { dailyUsed: 7, periodUsed: 7 }, 3).ok,
    ).toBe(true);
  });

  it("daily is checked before period (more actionable reason wins)", () => {
    const plan = {
      dailyGenerationLimit: 5,
      monthlyGenerationQuota: 10,
      maxWorkspaces: 1,
    };
    const d = evaluateGenerationQuota(plan, { dailyUsed: 5, periodUsed: 10 }, 1);
    expect(d.reason).toBe("DAILY_LIMIT");
  });

  it("clamps a 0/negative count up to 1 so it still gates", () => {
    const plan = {
      dailyGenerationLimit: 1,
      monthlyGenerationQuota: 100,
      maxWorkspaces: 1,
    };
    expect(
      evaluateGenerationQuota(plan, { dailyUsed: 1, periodUsed: 1 }, 0).ok,
    ).toBe(false);
  });
});

describe("isUnlimited", () => {
  it("treats -1 as unlimited and any non-negative as finite", () => {
    expect(isUnlimited(UNLIMITED)).toBe(true);
    expect(isUnlimited(0)).toBe(false);
    expect(isUnlimited(5)).toBe(false);
  });
});

describe("canCreateWorkspace", () => {
  it("unlimited (-1) always allows another workspace", () => {
    expect(canCreateWorkspace(UNLIMITED, 999)).toBe(true);
  });
  it("a finite cap blocks once reached", () => {
    expect(canCreateWorkspace(3, 2)).toBe(true);
    expect(canCreateWorkspace(3, 3)).toBe(false);
    expect(canCreateWorkspace(1, 1)).toBe(false);
  });
});

describe("dedupedSceneCount", () => {
  it("counts the DISTINCT scene set, not raw length (no false 402)", () => {
    expect(dedupedSceneCount(["A", "B", "A", "C", "B"])).toBe(3);
    expect(dedupedSceneCount(["A"])).toBe(1);
    expect(dedupedSceneCount([])).toBe(0);
  });
});

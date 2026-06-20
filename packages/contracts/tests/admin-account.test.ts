import { describe, expect, it } from "vitest";
import {
  AdminWorkspaceSummary,
  AdminWorkspaceDetail,
  ChangePasswordInput,
  RegistrationState,
  UpdateRegistrationInput,
} from "../src/index";

/**
 * Locks the contracts for the admin global-workspaces view, the registration
 * switch, and change-own-password — including the null-vs-optional invariant on
 * the optional identity fields (`.optional()` must reject explicit null).
 */
describe("AdminWorkspaceSummary", () => {
  const base = {
    id: "w1",
    name: "Acme",
    ownerId: "u1",
    ownerEmail: "a@b.com",
    createdAt: "2026-05-27T00:00:00.000Z",
    assetCount: 0,
    ruleCount: 0,
    projectCount: 0,
    generationCount: 0,
    memberCount: 1,
  };

  it("accepts a row with the optional identity fields omitted", () => {
    expect(AdminWorkspaceSummary.safeParse(base).success).toBe(true);
  });

  it("rejects explicit null on an optional field (the bug shape)", () => {
    expect(
      AdminWorkspaceSummary.safeParse({ ...base, industry: null, ownerName: null })
        .success,
    ).toBe(false);
  });

  it("rejects a negative count", () => {
    expect(
      AdminWorkspaceSummary.safeParse({ ...base, assetCount: -1 }).success,
    ).toBe(false);
  });
});

describe("AdminWorkspaceDetail", () => {
  it("round-trips a minimal detail with empty lists", () => {
    expect(
      AdminWorkspaceDetail.safeParse({
        id: "w1",
        name: "Acme",
        ownerId: "u1",
        ownerEmail: "a@b.com",
        createdAt: "2026-05-27T00:00:00.000Z",
        members: [],
        rules: [],
        projects: [],
      }).success,
    ).toBe(true);
  });
});

describe("RegistrationState / UpdateRegistrationInput", () => {
  it("requires a boolean", () => {
    expect(RegistrationState.safeParse({ registrationOpen: true }).success).toBe(
      true,
    );
    expect(
      UpdateRegistrationInput.safeParse({ registrationOpen: "yes" }).success,
    ).toBe(false);
  });
});

describe("ChangePasswordInput", () => {
  it("enforces the 8-char floor on the new password", () => {
    expect(
      ChangePasswordInput.safeParse({
        currentPassword: "x",
        newPassword: "longenough",
      }).success,
    ).toBe(true);
    expect(
      ChangePasswordInput.safeParse({
        currentPassword: "x",
        newPassword: "short",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty current password", () => {
    expect(
      ChangePasswordInput.safeParse({
        currentPassword: "",
        newPassword: "longenough",
      }).success,
    ).toBe(false);
  });
});

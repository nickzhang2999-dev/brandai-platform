/** K2 — pure export/download release gating (separation of duties). */
import { describe, expect, it } from "vitest";
import {
  canReleaseVersion,
  filterReleasableVersions,
  hasUnrestrictedRelease,
  isReleasedVersion,
} from "../src/release-policy";

const draft = { isFinal: false, reviewStatus: "PENDING" };
const submitted = { isFinal: false, reviewStatus: "SUBMITTED" };
const approved = { isFinal: false, reviewStatus: "APPROVED" };
const finalDraft = { isFinal: true, reviewStatus: "PENDING" };

describe("hasUnrestrictedRelease", () => {
  it("only OWNER has unrestricted release", () => {
    expect(hasUnrestrictedRelease("OWNER")).toBe(true);
    expect(hasUnrestrictedRelease("EDITOR")).toBe(false);
    expect(hasUnrestrictedRelease("REVIEWER")).toBe(false);
    expect(hasUnrestrictedRelease("VIEWER")).toBe(false);
    expect(hasUnrestrictedRelease(null)).toBe(false);
  });
});

describe("isReleasedVersion", () => {
  it("released = final OR approved", () => {
    expect(isReleasedVersion(draft)).toBe(false);
    expect(isReleasedVersion(submitted)).toBe(false);
    expect(isReleasedVersion(approved)).toBe(true);
    expect(isReleasedVersion(finalDraft)).toBe(true);
  });
});

describe("canReleaseVersion", () => {
  it("OWNER may download/export ANY version incl. unapproved drafts (phase-1 loop intact)", () => {
    expect(canReleaseVersion("OWNER", draft)).toBe(true);
    expect(canReleaseVersion("OWNER", submitted)).toBe(true);
    expect(canReleaseVersion("OWNER", approved)).toBe(true);
    expect(canReleaseVersion("OWNER", finalDraft)).toBe(true);
  });

  it("a non-owner collaborator may ONLY get released (final/approved) versions", () => {
    for (const role of ["EDITOR", "REVIEWER", "VIEWER", null] as const) {
      expect(canReleaseVersion(role, draft)).toBe(false);
      expect(canReleaseVersion(role, submitted)).toBe(false);
      expect(canReleaseVersion(role, approved)).toBe(true);
      expect(canReleaseVersion(role, finalDraft)).toBe(true);
    }
  });
});

describe("filterReleasableVersions", () => {
  const all = [draft, submitted, approved, finalDraft];

  it("owner export keeps everything", () => {
    expect(filterReleasableVersions("OWNER", all)).toHaveLength(4);
  });

  it("collaborator export drops unapproved drafts", () => {
    const out = filterReleasableVersions("VIEWER", all);
    expect(out).toHaveLength(2);
    expect(out).toEqual([approved, finalDraft]);
  });
});

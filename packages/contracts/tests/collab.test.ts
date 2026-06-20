/** G6 — collaboration + approval contract shapes. */
import { describe, expect, it } from "vitest";
import {
  InviteMemberInput,
  MemberSummary,
  ReviewDecisionInput,
} from "../src/collab";
import { GenerationVersion } from "../src/entities";

describe("G6 contracts", () => {
  it("InviteMemberInput requires a valid email and an invitable (non-OWNER) role", () => {
    expect(InviteMemberInput.safeParse({ email: "a@b.co", role: "EDITOR" }).success).toBe(true);
    expect(InviteMemberInput.safeParse({ email: "a@b.co", role: "OWNER" }).success).toBe(false);
    expect(InviteMemberInput.safeParse({ email: "nope", role: "VIEWER" }).success).toBe(false);
  });

  it("ReviewDecisionInput only accepts APPROVED/REJECTED", () => {
    expect(ReviewDecisionInput.safeParse({ decision: "APPROVED" }).success).toBe(true);
    expect(ReviewDecisionInput.safeParse({ decision: "SUBMITTED" }).success).toBe(false);
  });

  it("MemberSummary omits optional name (null-vs-optional)", () => {
    const ok = MemberSummary.safeParse({
      userId: "u1", email: "a@b.co", role: "EDITOR", isOwner: false,
      createdAt: new Date(0).toISOString(),
    });
    expect(ok.success).toBe(true);
    const bad = MemberSummary.safeParse({
      userId: "u1", email: "a@b.co", name: null, role: "EDITOR", isOwner: false,
      createdAt: new Date(0).toISOString(),
    });
    expect(bad.success).toBe(false);
  });

  it("GenerationVersion defaults reviewStatus to PENDING (frozen-additive)", () => {
    const r = GenerationVersion.safeParse({
      id: "v1", generationId: "g1", index: 0, imageUrl: "x", width: 10, height: 10,
      params: {}, createdAt: new Date(0).toISOString(),
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.reviewStatus).toBe("PENDING");
  });
});

import { z } from "zod";
import { WorkspaceRole } from "./enums";

/**
 * G6 团队协作 + 审批流 — web-BFF-only contract (no AI service counterpart).
 */

/** A workspace member row. `isOwner` mirrors the workspace.ownerId (the OWNER
 *  role is also stored as a Membership, but the owner can't be demoted/removed).
 *  `name` is `.optional()` (omitted, not null) per the null-vs-optional boundary. */
export const MemberSummary = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().optional(),
  role: WorkspaceRole,
  isOwner: z.boolean(),
  createdAt: z.string(),
});
export type MemberSummary = z.infer<typeof MemberSummary>;

export const ListMembersResponse = z.object({
  members: z.array(MemberSummary),
  /** the caller's own effective role — drives which member actions the UI shows */
  myRole: WorkspaceRole,
});
export type ListMembersResponse = z.infer<typeof ListMembersResponse>;

/** Invitable roles exclude OWNER (ownership transfer is out of scope). */
export const InvitableRole = z.enum(["EDITOR", "REVIEWER", "VIEWER"]);
export type InvitableRole = z.infer<typeof InvitableRole>;

/** Invite an ALREADY-REGISTERED user by email into the workspace. */
export const InviteMemberInput = z.object({
  email: z.string().email(),
  role: InvitableRole,
});
export type InviteMemberInput = z.infer<typeof InviteMemberInput>;

export const UpdateMemberInput = z.object({ role: InvitableRole });
export type UpdateMemberInput = z.infer<typeof UpdateMemberInput>;

/** Reviewer/owner decision on a submitted version. */
export const ReviewDecisionInput = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().trim().max(500).optional(),
});
export type ReviewDecisionInput = z.infer<typeof ReviewDecisionInput>;

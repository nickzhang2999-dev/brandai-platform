/**
 * K2 — pure release/download gating policy. Separation of duties: an owner (or
 * a future FULL_ACCESS role) may export/download ANY version, including
 * unapproved drafts; a non-owner collaborator (EDITOR / REVIEWER / VIEWER) may
 * only pull versions that have been RELEASED — i.e. marked final OR approved in
 * the G6 review workflow. This prevents a collaborator from exfiltrating
 * in-progress drafts via the delivery ZIP or single-image download.
 *
 * Kept in `@brandai/contracts` (zero deps) so the decision is unit-testable in
 * the L1 suite without spinning up a DB or HTTP layer.
 */

import type { WorkspaceRole } from "./enums";

/** Minimal version shape the gate needs (a subset of GenerationVersion). */
export interface ReleaseGateVersion {
  isFinal: boolean;
  /** G6 review verdict. Only "APPROVED" counts as released. */
  reviewStatus: string;
}

/**
 * Owner has unrestricted access to their own tenant's outputs — the phase-1
 * super-admin closed loop (generate → set final → export ZIP) must keep working
 * with zero review ceremony. Only collaborators are restricted.
 */
export function hasUnrestrictedRelease(role: WorkspaceRole | null): boolean {
  return role === "OWNER";
}

/** A version is "released" once it's final OR approved. */
export function isReleasedVersion(v: ReleaseGateVersion): boolean {
  return v.isFinal || v.reviewStatus === "APPROVED";
}

/**
 * Whether `role` may download / export `version`. Owner: always. Anyone else:
 * only released (final/approved) versions.
 */
export function canReleaseVersion(
  role: WorkspaceRole | null,
  version: ReleaseGateVersion,
): boolean {
  if (hasUnrestrictedRelease(role)) return true;
  return isReleasedVersion(version);
}

/**
 * Filter a list of versions down to what `role` is allowed to receive. Used by
 * the export route to silently drop drafts for collaborators while letting the
 * owner export everything.
 */
export function filterReleasableVersions<T extends ReleaseGateVersion>(
  role: WorkspaceRole | null,
  versions: readonly T[],
): T[] {
  if (hasUnrestrictedRelease(role)) return [...versions];
  return versions.filter(isReleasedVersion);
}

/**
 * K1 — pure quota policy math. Kept in `@brandai/contracts` (zero deps, runs in
 * the L1 vitest suite) so the daily/period/maxWorkspaces decisions are unit
 * testable WITHOUT a DB. The web side (`apps/web/src/lib/quota.ts`) owns the
 * IO (resolve plan, count usage in a transaction) and delegates the actual
 * "is this allowed?" decision here.
 *
 * Invariant for phase-1: a limit of `-1` ALWAYS means unlimited. The default /
 * owner / admin plan resolves to -1 everywhere, so these checks are no-ops for
 * the super-admin closed loop — enforcement only ever fires when a real finite
 * plan limit is configured AND would be exceeded.
 */

/** Sentinel for "no limit" on any plan field. */
export const UNLIMITED = -1;

export interface QuotaLimits {
  /** Per-day generation rate limit; -1 = unlimited. */
  dailyGenerationLimit: number;
  /** Per-billing-period generation quota; -1 = unlimited. */
  monthlyGenerationQuota: number;
  /** Max workspaces (tenants/brands) the owner may create; -1 = unlimited. */
  maxWorkspaces: number;
}

export type QuotaDenyReason = "DAILY_LIMIT" | "PERIOD_QUOTA";

export interface QuotaDecision {
  /** true when the requested `count` generations fit under both limits. */
  ok: boolean;
  /** populated only when `ok` is false. */
  reason?: QuotaDenyReason;
  limit?: number;
  used?: number;
  requested?: number;
}

/** True when a single limit value means "unlimited". */
export function isUnlimited(limit: number): boolean {
  return limit === UNLIMITED;
}

/**
 * Decide whether `count` more generations are allowed given the plan limits and
 * the current usage. Daily is checked before period so a user hitting the
 * rate-limit gets the (more actionable) "try tomorrow" reason first.
 *
 * `count` is clamped to a minimum of 1, so a malformed 0/negative still gates a
 * single generation rather than slipping through.
 */
export function evaluateGenerationQuota(
  limits: QuotaLimits,
  usage: { dailyUsed: number; periodUsed: number },
  count = 1,
): QuotaDecision {
  const n = Math.max(1, count);

  if (
    !isUnlimited(limits.dailyGenerationLimit) &&
    usage.dailyUsed + n > limits.dailyGenerationLimit
  ) {
    return {
      ok: false,
      reason: "DAILY_LIMIT",
      limit: limits.dailyGenerationLimit,
      used: usage.dailyUsed,
      requested: n,
    };
  }

  if (
    !isUnlimited(limits.monthlyGenerationQuota) &&
    usage.periodUsed + n > limits.monthlyGenerationQuota
  ) {
    return {
      ok: false,
      reason: "PERIOD_QUOTA",
      limit: limits.monthlyGenerationQuota,
      used: usage.periodUsed,
      requested: n,
    };
  }

  return { ok: true };
}

/**
 * True when the owner may create one MORE workspace. `currentCount` is how many
 * they already own. `-1` (unlimited) always allows.
 */
export function canCreateWorkspace(
  maxWorkspaces: number,
  currentCount: number,
): boolean {
  if (isUnlimited(maxWorkspaces)) return true;
  return currentCount < maxWorkspaces;
}

/**
 * K1 / Campaign Kit billing — the number of generations a kit actually meters.
 * The fan-out creates ONE generation per DISTINCT scene type, so quota must be
 * counted on the deduped set, not the raw `scenes.length` (a repeated scene
 * would otherwise inflate the count and trigger a false 402).
 */
export function dedupedSceneCount(scenes: readonly string[]): number {
  return new Set(scenes).size;
}

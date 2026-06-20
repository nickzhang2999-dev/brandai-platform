import { prisma } from "@brandai/db";
import { ApiException } from "@/lib/api";
import { adminEmails } from "@/lib/admin";

/**
 * M-D · 配额/限流 (D4) + 订阅分层 (D5).
 *
 * Usage is derived from existing Generation rows (count of generation requests
 * across the user's owned workspaces) rather than a separate counter table —
 * no extra write path, and the [workspaceId, createdAt] index keeps it cheap.
 *
 * Quota is enforced on the metered action (POST .../generations). A user with
 * no Subscription row is treated as the STARTER free tier, so enforcement
 * works before any billing integration exists. Set QUOTA_V1=0 to disable.
 *
 * `-1` on any plan limit means unlimited.
 */

export function quotaEnabled(): boolean {
  return (process.env.QUOTA_V1 ?? "1") !== "0";
}

const UNLIMITED = -1;

export interface ResolvedPlan {
  tier: string;
  name: string;
  monthlyGenerationQuota: number;
  dailyGenerationLimit: number;
  maxWorkspaces: number;
  periodStart: Date;
}

/** Start of the current UTC day. */
function startOfDayUTC(now = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/** Start of the current UTC calendar month (fallback billing period). */
function startOfMonthUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * True if the user counts as a platform admin, using the SAME precedence as
 * lib/admin.ts#isAdminUser so quota/tier never disagrees with who can actually
 * reach /admin: when ADMIN_EMAILS is set that allowlist is authoritative (a
 * stale User.isAdmin row does NOT grant access), otherwise fall back to the
 * User.isAdmin bootstrap flag. Keeping this in lockstep avoids the split-brain
 * where someone removed from ADMIN_EMAILS loses admin yet keeps unlimited quota.
 */
export function effectiveAdmin(
  email: string | null | undefined,
  dbIsAdmin: boolean,
): boolean {
  const allow = adminEmails();
  if (allow.length > 0) {
    return !!email && allow.includes(email.trim().toLowerCase());
  }
  return dbIsAdmin;
}

/**
 * Resolve the user's effective plan + current period start.
 *
 * Order: ACTIVE Subscription → ENTERPRISE-shim for platform admins → STARTER.
 * The admin shim means an operator with no Subscription row is treated as
 * ENTERPRISE everywhere (unlimited quota, "Enterprise" badge in UI), without
 * needing to seed a Subscription per admin. ENTERPRISE Plan row defaults to
 * -1 / -1 (unlimited) — see seed.ts.
 */
export async function resolvePlan(userId: string): Promise<ResolvedPlan> {
  const sub = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true },
  });
  if (sub && sub.status === "ACTIVE") {
    return {
      tier: sub.plan.tier,
      name: sub.plan.name,
      monthlyGenerationQuota: sub.plan.monthlyGenerationQuota,
      dailyGenerationLimit: sub.plan.dailyGenerationLimit,
      maxWorkspaces: sub.plan.maxWorkspaces,
      periodStart: sub.currentPeriodStart,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, isAdmin: true },
  });

  if (user && effectiveAdmin(user.email, user.isAdmin)) {
    const enterprise = await prisma.plan.findUnique({
      where: { tier: "ENTERPRISE" },
    });
    return {
      tier: "ENTERPRISE",
      name: enterprise?.name ?? "Enterprise",
      monthlyGenerationQuota: enterprise?.monthlyGenerationQuota ?? UNLIMITED,
      dailyGenerationLimit: enterprise?.dailyGenerationLimit ?? UNLIMITED,
      maxWorkspaces: enterprise?.maxWorkspaces ?? UNLIMITED,
      periodStart: startOfMonthUTC(),
    };
  }

  const starter = await prisma.plan.findUnique({
    where: { tier: "STARTER" },
  });
  return {
    tier: "STARTER",
    name: starter?.name ?? "Starter",
    monthlyGenerationQuota: starter?.monthlyGenerationQuota ?? 20,
    dailyGenerationLimit: starter?.dailyGenerationLimit ?? 5,
    maxWorkspaces: starter?.maxWorkspaces ?? 1,
    periodStart: startOfMonthUTC(),
  };
}

async function ownedWorkspaceIds(userId: string): Promise<string[]> {
  const rows = await prisma.brandWorkspace.findMany({
    where: { ownerId: userId },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export interface QuotaUsage {
  plan: ResolvedPlan;
  dailyUsed: number;
  periodUsed: number;
}

export async function getUsage(userId: string): Promise<QuotaUsage> {
  const plan = await resolvePlan(userId);
  const wsIds = await ownedWorkspaceIds(userId);
  if (wsIds.length === 0) {
    return { plan, dailyUsed: 0, periodUsed: 0 };
  }
  const [dailyUsed, periodUsed] = await Promise.all([
    prisma.generation.count({
      where: { workspaceId: { in: wsIds }, createdAt: { gte: startOfDayUTC() } },
    }),
    prisma.generation.count({
      where: {
        workspaceId: { in: wsIds },
        createdAt: { gte: plan.periodStart },
      },
    }),
  ]);
  return { plan, dailyUsed, periodUsed };
}

export interface QuotaStatus {
  /** Generations counted across the user's owned workspaces today (UTC). */
  dailyUsed: number;
  /** Daily limit for the resolved plan; -1 = unlimited. */
  dailyLimit: number;
  /** Generations counted in the current billing period. */
  periodUsed: number;
  /** Monthly quota for the resolved plan; -1 = unlimited. */
  monthlyQuota: number;
  /** Resolved plan tier (STARTER / ENTERPRISE / …). */
  plan: string;
}

/**
 * Read-only quota status for display (F11). Reuses the SAME plan resolution +
 * usage counting as enforcement — no separate counter — so what the UI shows
 * always matches what `assertGenerationQuota` enforces. `-1` on a limit means
 * unlimited. This NEVER throws a 402 / mutates anything.
 */
export async function getQuotaStatus(userId: string): Promise<QuotaStatus> {
  const { plan, dailyUsed, periodUsed } = await getUsage(userId);
  return {
    dailyUsed,
    dailyLimit: plan.dailyGenerationLimit,
    periodUsed,
    monthlyQuota: plan.monthlyGenerationQuota,
    plan: plan.tier,
  };
}

/**
 * Throw 402 when the next `count` generations would exceed the daily rate limit
 * or the monthly quota. Call this BEFORE creating the Generation row(s). For a
 * Campaign Kit, pass `count = scenes.length` so the WHOLE set is gated at once
 * (no half-finished kit). No-op when QUOTA_V1=0. `count` defaults to 1.
 */
export async function assertGenerationQuota(
  userId: string,
  count = 1,
): Promise<void> {
  if (!quotaEnabled()) return;

  // Admin handling is centralized in resolvePlan — operators resolve to the
  // ENTERPRISE plan (unlimited limits), so the checks below naturally pass for
  // them. No special-case here keeps quota and tier display consistent.
  const { plan, dailyUsed, periodUsed } = await getUsage(userId);
  const n = Math.max(1, count);

  if (
    plan.dailyGenerationLimit !== UNLIMITED &&
    dailyUsed + n > plan.dailyGenerationLimit
  ) {
    throw new ApiException(402, "已达当日生成上限,请明日再试或升级订阅", {
      reason: "DAILY_LIMIT",
      tier: plan.tier,
      limit: plan.dailyGenerationLimit,
      used: dailyUsed,
      requested: n,
    });
  }

  if (
    plan.monthlyGenerationQuota !== UNLIMITED &&
    periodUsed + n > plan.monthlyGenerationQuota
  ) {
    throw new ApiException(402, "已达本周期生成配额,请升级订阅以继续", {
      reason: "PERIOD_QUOTA",
      tier: plan.tier,
      limit: plan.monthlyGenerationQuota,
      used: periodUsed,
      requested: n,
    });
  }
}

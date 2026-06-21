import { prisma, Prisma } from "@brandai/db";
import {
  canCreateWorkspace,
  evaluateGenerationQuota,
  UNLIMITED,
} from "@brandai/contracts";
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

/**
 * §3.5 isolation rule 3 — quota/billing is metered by workspace OWNER (tenant),
 * NOT the invoking collaborator. A shared-workspace generation must count
 * against the owner so a collaborator can't burn unmetered generations and so
 * the owner's plan is the one enforced. Returns the owner's userId (used as the
 * quota subject everywhere a generation is initiated in a workspace).
 */
export async function getWorkspaceOwnerId(
  workspaceId: string,
): Promise<string> {
  const ws = await prisma.brandWorkspace.findUnique({
    where: { id: workspaceId },
    select: { ownerId: true },
  });
  if (!ws) throw new ApiException(404, "Workspace not found");
  return ws.ownerId;
}

export interface QuotaUsage {
  plan: ResolvedPlan;
  dailyUsed: number;
  periodUsed: number;
}

/**
 * Count the owner's generations in the daily + period windows. FAILED rows are
 * EXCLUDED — a generation that errored out is "released" (settled) and must not
 * permanently consume quota (K1: reserve before enqueue, release on terminal
 * failure). Optionally runs inside a transaction client so the count and the
 * reservation insert are atomic (see `reserveGenerationQuota`).
 */
async function countOwnerUsage(
  client: Prisma.TransactionClient | typeof prisma,
  wsIds: string[],
  periodStart: Date,
): Promise<{ dailyUsed: number; periodUsed: number }> {
  if (wsIds.length === 0) return { dailyUsed: 0, periodUsed: 0 };
  const released: Prisma.GenerationWhereInput = {
    workspaceId: { in: wsIds },
    // Release-on-failure ONLY when nothing usable remains. A plain FAILED
    // attempt (no versions) is released; but a FAILED *rerun* that kept its
    // prior root versions still has downloadable/exportable output, so it must
    // keep holding its slot — otherwise a user could free a slot by triggering
    // a failed rerun while retaining the old image.
    NOT: { status: "FAILED", versions: { none: {} } },
  };
  const [dailyUsed, periodUsed] = await Promise.all([
    client.generation.count({
      where: { ...released, createdAt: { gte: startOfDayUTC() } },
    }),
    client.generation.count({
      where: { ...released, createdAt: { gte: periodStart } },
    }),
  ]);
  return { dailyUsed, periodUsed };
}

export async function getUsage(userId: string): Promise<QuotaUsage> {
  const plan = await resolvePlan(userId);
  const wsIds = await ownedWorkspaceIds(userId);
  const { dailyUsed, periodUsed } = await countOwnerUsage(
    prisma,
    wsIds,
    plan.periodStart,
  );
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

/** Translate a policy deny decision into the 402 ApiException the UI expects. */
function denyToException(
  tier: string,
  decision: ReturnType<typeof evaluateGenerationQuota>,
): ApiException {
  const msg =
    decision.reason === "DAILY_LIMIT"
      ? "已达当日生成上限,请明日再试或升级订阅"
      : "已达本周期生成配额,请升级订阅以继续";
  return new ApiException(402, msg, {
    reason: decision.reason,
    tier,
    limit: decision.limit,
    used: decision.used,
    requested: decision.requested,
  });
}

/**
 * Throw 402 when the next `count` generations would exceed the daily rate limit
 * or the monthly quota, metered against the workspace OWNER (tenant). Call this
 * BEFORE creating the Generation row(s). For a Campaign Kit, pass the DEDUPED
 * scene count so the WHOLE set is gated at once (no half-finished kit, no false
 * 402 from a repeated scene). No-op when QUOTA_V1=0. `count` defaults to 1.
 *
 * NOTE: this is the NON-atomic read-then-act check used by the synchronous
 * surface (fast 402 feedback). Routes that actually create the Generation row
 * should use `reserveGenerationQuota` so concurrent requests can't over-spend.
 */
export async function assertGenerationQuota(
  ownerUserId: string,
  count = 1,
): Promise<void> {
  if (!quotaEnabled()) return;

  // Admin handling is centralized in resolvePlan — operators resolve to the
  // ENTERPRISE plan (unlimited limits), so the policy below is a no-op for them.
  const { plan, dailyUsed, periodUsed } = await getUsage(ownerUserId);
  const decision = evaluateGenerationQuota(
    plan,
    { dailyUsed, periodUsed },
    count,
  );
  if (!decision.ok) throw denyToException(plan.tier, decision);
}

/**
 * K1 — quota gate for 重新生成 (regenerate). Regenerate re-runs an EXISTING
 * Generation row rather than creating a new one, so its quota accounting depends
 * on the prior terminal state:
 *  - prior FAILED: the slot was released (FAILED is excluded from usage), so the
 *    re-run consumes a fresh slot → gate as +1.
 *  - prior SUCCEEDED: the row already holds its slot (still counted), so the
 *    re-run does NOT consume a new slot → gate at the CURRENT usage (no +1),
 *    only blocking if the owner is already over a (since-lowered) limit.
 *
 * Metered against the workspace OWNER. No-op when QUOTA_V1=0 / unlimited plan.
 */
export async function assertRegenerateQuota(
  workspaceId: string,
  priorStatus: string,
  priorCreatedAt: Date,
): Promise<void> {
  if (!quotaEnabled()) return;
  const ownerId = await getWorkspaceOwnerId(workspaceId);
  const { plan, dailyUsed, periodUsed } = await getUsage(ownerId);
  // The prior row only occupies a slot in the windows it actually falls within.
  // Regenerate resets the row's createdAt to now, so a prior success from an
  // EARLIER day/period consumes a NEW current-window slot and must be gated
  // like one (no subtraction) — otherwise an at-limit owner could rerun a stale
  // success for free. Subtract its slot only where it's truly counted: a
  // non-released (non-FAILED) prior whose createdAt is inside that window.
  const priorCounted = priorStatus !== "FAILED";
  const inDaily = priorCounted && priorCreatedAt >= startOfDayUTC();
  const inPeriod = priorCounted && priorCreatedAt >= plan.periodStart;
  const decision = evaluateGenerationQuota(
    plan,
    {
      dailyUsed: inDaily ? Math.max(0, dailyUsed - 1) : dailyUsed,
      periodUsed: inPeriod ? Math.max(0, periodUsed - 1) : periodUsed,
    },
    1,
  );
  if (!decision.ok) throw denyToException(plan.tier, decision);
}

/**
 * K1 — ATOMIC quota reservation. Resolves the workspace owner (tenant), then in
 * a SERIALIZABLE transaction: counts the owner's released usage AND creates the
 * `count` PENDING Generation rows in the SAME transaction. Because the count and
 * the inserts are serialized, two concurrent requests can't both read "1 slot
 * left" and each create a row — the second transaction sees the first's rows (or
 * conflicts and retries), so the limit holds under concurrency.
 *
 * The PENDING Generation rows ARE the reservation: a later FAILED terminal
 * status releases the slot (countOwnerUsage excludes FAILED). Returns the
 * created Generation rows so the caller can enqueue their jobs.
 *
 * `make` builds the per-row create data (scene type / selling point / etc).
 */
export async function reserveGenerationQuota(args: {
  workspaceId: string;
  count: number;
  make: (i: number) => Prisma.GenerationCreateManyInput;
}): Promise<{ id: string }[]> {
  const n = Math.max(1, args.count);
  const ownerId = await getWorkspaceOwnerId(args.workspaceId);
  const plan = await resolvePlan(ownerId);
  const wsIds = await ownedWorkspaceIds(ownerId);

  // Fast path: unlimited plan (default / owner / admin) → no transaction
  // overhead, no serialization, identical phase-1 behavior.
  const unlimited =
    !quotaEnabled() ||
    (plan.dailyGenerationLimit === UNLIMITED &&
      plan.monthlyGenerationQuota === UNLIMITED);

  if (unlimited) {
    const created: { id: string }[] = [];
    for (let i = 0; i < n; i += 1) {
      const row = await prisma.generation.create({
        data: args.make(i),
        select: { id: true },
      });
      created.push(row);
    }
    return created;
  }

  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const { dailyUsed, periodUsed } = await countOwnerUsage(
        tx,
        wsIds,
        plan.periodStart,
      );
      const decision = evaluateGenerationQuota(
        plan,
        { dailyUsed, periodUsed },
        n,
      );
      if (!decision.ok) throw denyToException(plan.tier, decision);

      const created: { id: string }[] = [];
      for (let i = 0; i < n; i += 1) {
        const row = await tx.generation.create({
          data: args.make(i),
          select: { id: true },
        });
        created.push(row);
      }
      return created;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

/**
 * K1 — enforce the plan's `maxWorkspaces` (tenant cap) on workspace creation.
 * Counts the user's currently-owned workspaces and throws 402 when creating one
 * more would exceed the plan. Unlimited (-1, the default/owner/admin plan) is a
 * no-op, so phase-1 single-brand auto-create is untouched. No-op when QUOTA_V1=0.
 */
export async function assertCanCreateWorkspace(userId: string): Promise<void> {
  if (!quotaEnabled()) return;
  const plan = await resolvePlan(userId);
  if (plan.maxWorkspaces === UNLIMITED) return;
  const current = await prisma.brandWorkspace.count({
    where: { ownerId: userId },
  });
  if (!canCreateWorkspace(plan.maxWorkspaces, current)) {
    throw new ApiException(402, "已达套餐可创建品牌数量上限,请升级订阅", {
      reason: "MAX_WORKSPACES",
      tier: plan.tier,
      limit: plan.maxWorkspaces,
      used: current,
    });
  }
}

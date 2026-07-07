import { z } from "zod";

/**
 * Platform admin — user management (/admin/users). Web-BFF-only contract (no AI
 * service counterpart, so no Pydantic mirror). Gated to ADMIN_EMAILS via
 * requireAdmin on every route.
 */

/**
 * One row of the admin user list: identity + the operator-relevant facts
 * (brand-space count, effective subscription quota, registration time, and the
 * enabled/admin flags the table acts on). `name` is `.optional()` (omitted, not
 * null) to honour the null-vs-optional contract boundary.
 */
export const AdminUserSummary = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().optional(),
  isAdmin: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.string(),
  workspaceCount: z.number().int().nonnegative(),
  /** Effective plan (STARTER when the user has no active subscription). */
  planTier: z.string(),
  planName: z.string(),
  /** -1 = unlimited (mirrors Plan quota semantics). */
  monthlyGenerationQuota: z.number().int(),
  dailyGenerationLimit: z.number().int(),
});
export type AdminUserSummary = z.infer<typeof AdminUserSummary>;

export const AdminListUsersResponse = z.object({
  users: z.array(AdminUserSummary),
});
export type AdminListUsersResponse = z.infer<typeof AdminListUsersResponse>;

/** PATCH /api/admin/users/[userId] — enable/disable a user account. */
export const AdminUpdateUserInput = z.object({
  isActive: z.boolean(),
});
export type AdminUpdateUserInput = z.infer<typeof AdminUpdateUserInput>;

/**
 * T-conn-b — admin usage/cost dashboard (/admin/usage). Aggregated from the
 * append-only UsageLog over a recent window, grouped by UTC day × model.
 * `costUsd` is a USD sum (0 when every contributing call was unpriced/mock).
 */
export const AdminUsageRow = z.object({
  date: z.string(), // YYYY-MM-DD (UTC)
  model: z.string(), // "(default)" when the provider sent no model id
  calls: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  imageCount: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type AdminUsageRow = z.infer<typeof AdminUsageRow>;

export const AdminUsageResponse = z.object({
  sinceDays: z.number().int().positive(),
  rows: z.array(AdminUsageRow),
  totals: z.object({
    calls: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    imageCount: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
  }),
});
export type AdminUsageResponse = z.infer<typeof AdminUsageResponse>;

/**
 * Platform admin — global, read-only view of EVERY brand workspace (across all
 * owners). One row of /admin/workspaces: identity + owner + content counts so
 * the operator can see who has what without joining the workspace. Read-only:
 * there are no admin write routes for workspace content.
 */
export const AdminWorkspaceSummary = z.object({
  id: z.string(),
  name: z.string(),
  industry: z.string().optional(),
  ownerId: z.string(),
  ownerEmail: z.string(),
  ownerName: z.string().optional(),
  createdAt: z.string(),
  assetCount: z.number().int().nonnegative(),
  ruleCount: z.number().int().nonnegative(),
  projectCount: z.number().int().nonnegative(),
  generationCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
});
export type AdminWorkspaceSummary = z.infer<typeof AdminWorkspaceSummary>;

export const AdminListWorkspacesResponse = z.object({
  workspaces: z.array(AdminWorkspaceSummary),
});
export type AdminListWorkspacesResponse = z.infer<
  typeof AdminListWorkspacesResponse
>;

/** A generated image inside the admin workspace detail (read-only preview). */
export const AdminWorkspaceImage = z.object({
  versionId: z.string(),
  imageUrl: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  isFinal: z.boolean(),
  reviewStatus: z.string(),
  createdAt: z.string(),
});
export type AdminWorkspaceImage = z.infer<typeof AdminWorkspaceImage>;

export const AdminWorkspaceGeneration = z.object({
  id: z.string(),
  sceneType: z.string(),
  sellingPoint: z.string(),
  status: z.string(),
  createdAt: z.string(),
  images: z.array(AdminWorkspaceImage),
});
export type AdminWorkspaceGeneration = z.infer<
  typeof AdminWorkspaceGeneration
>;

export const AdminWorkspaceProject = z.object({
  id: z.string(),
  name: z.string(),
  campaign: z.string().optional(),
  createdAt: z.string(),
  generations: z.array(AdminWorkspaceGeneration),
});
export type AdminWorkspaceProject = z.infer<typeof AdminWorkspaceProject>;

export const AdminWorkspaceMember = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().optional(),
  role: z.string(),
});
export type AdminWorkspaceMember = z.infer<typeof AdminWorkspaceMember>;

export const AdminWorkspaceRule = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  strength: z.string(),
  summary: z.string(),
});
export type AdminWorkspaceRule = z.infer<typeof AdminWorkspaceRule>;

/** Full read-only payload for /admin/workspaces/[wsId]. */
export const AdminWorkspaceDetail = z.object({
  id: z.string(),
  name: z.string(),
  industry: z.string().optional(),
  websiteUrl: z.string().optional(),
  ownerId: z.string(),
  ownerEmail: z.string(),
  ownerName: z.string().optional(),
  createdAt: z.string(),
  members: z.array(AdminWorkspaceMember),
  rules: z.array(AdminWorkspaceRule),
  projects: z.array(AdminWorkspaceProject),
});
export type AdminWorkspaceDetail = z.infer<typeof AdminWorkspaceDetail>;

/**
 * Self-serve registration switch (/admin/users toggle). Default CLOSED — a
 * fresh deploy accepts no public sign-ups until a platform admin opens it. The
 * bootstrap-first-admin and ADMIN_EMAILS allowlist paths bypass this gate so an
 * operator is never locked out.
 */
export const RegistrationState = z.object({
  registrationOpen: z.boolean(),
});
export type RegistrationState = z.infer<typeof RegistrationState>;

export const UpdateRegistrationInput = z.object({
  registrationOpen: z.boolean(),
});
export type UpdateRegistrationInput = z.infer<typeof UpdateRegistrationInput>;

/**
 * Platform admin — subscription plan (tier) management (/admin/plans). One row
 * per SaaS tier with the operator-editable quota knobs. Users with no active
 * subscription resolve to STARTER (lib/quota.ts#resolvePlan), so raising the
 * STARTER limits here opens quota for every default-tier user at once — this is
 * the "改默认额度" surface. `-1` means unlimited (mirrors Plan quota semantics).
 */
export const AdminPlanSummary = z.object({
  tier: z.string(),
  name: z.string(),
  priceCentsMonthly: z.number().int().nonnegative(),
  /** -1 = unlimited. */
  monthlyGenerationQuota: z.number().int(),
  dailyGenerationLimit: z.number().int(),
  maxWorkspaces: z.number().int(),
});
export type AdminPlanSummary = z.infer<typeof AdminPlanSummary>;

export const AdminListPlansResponse = z.object({
  plans: z.array(AdminPlanSummary),
});
export type AdminListPlansResponse = z.infer<typeof AdminListPlansResponse>;

/**
 * PATCH /api/admin/plans/[tier] — edit a tier's quota knobs. Every field is an
 * integer ≥ -1 (with -1 meaning unlimited); a sane upper bound guards against
 * fat-finger values. `name` is trimmed and non-empty. All fields required so the
 * write is a full, unambiguous replacement of the editable columns.
 */
const quotaInt = z.number().int().gte(-1).lte(1_000_000);
export const AdminUpdatePlanInput = z.object({
  name: z.string().trim().min(1).max(60),
  monthlyGenerationQuota: quotaInt,
  dailyGenerationLimit: quotaInt,
  maxWorkspaces: quotaInt,
});
export type AdminUpdatePlanInput = z.infer<typeof AdminUpdatePlanInput>;

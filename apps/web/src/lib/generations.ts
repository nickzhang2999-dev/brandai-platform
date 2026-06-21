import { prisma } from "@brandai/db";
import {
  ComplianceReport,
  type ComplianceReport as ComplianceReportType,
  Generation,
  GenerationVersion,
  Project,
  type QueueItem,
} from "@brandai/contracts";
import { BRAND_PREVIEW_PROJECT_NAME } from "./brand-preview";

/**
 * Read-side helpers for Generation / GenerationVersion data, shaped to the
 * frozen `@brandai/contracts` schemas. M3 owns the write path; M4 (editing)
 * and M6 (version compare / export) import these to read clean, queryable
 * rows. Do not read the tables directly from other modules — go through here
 * so the contract shaping (ISO dates, nullable -> optional) stays consistent.
 */

type VersionRow = {
  id: string;
  generationId: string;
  index: number;
  imageUrl: string;
  width: number;
  height: number;
  params: unknown;
  complianceReport: unknown;
  parentVersionId: string | null;
  isFinal: boolean;
  reviewStatus: string;
  reviewedById: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  createdAt: Date;
};

type GenerationRow = {
  id: string;
  projectId: string;
  workspaceId: string;
  sceneType: string;
  sellingPoint: string;
  scene: string;
  status: string;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  versions: VersionRow[];
};

/** Normalise a Prisma GenerationVersion row to the contracts shape. */
export function serializeVersion(row: VersionRow): GenerationVersion {
  const rawReport = row.complianceReport;
  const report =
    rawReport && typeof rawReport === "object"
      ? ComplianceReport.safeParse(rawReport)
      : null;
  return GenerationVersion.parse({
    id: row.id,
    generationId: row.generationId,
    index: row.index,
    imageUrl: row.imageUrl,
    width: row.width,
    height: row.height,
    params: (row.params ?? {}) as Record<string, unknown>,
    complianceReport: report?.success ? report.data : undefined,
    parentVersionId: row.parentVersionId ?? undefined,
    isFinal: row.isFinal,
    reviewStatus: row.reviewStatus,
    reviewedById: row.reviewedById ?? undefined,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : undefined,
    reviewNote: row.reviewNote ?? undefined,
    createdAt: row.createdAt.toISOString(),
  });
}

/** Normalise a Prisma Generation (with versions) row to the contracts shape. */
export function serializeGeneration(row: GenerationRow): Generation {
  return Generation.parse({
    id: row.id,
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    sceneType: row.sceneType,
    sellingPoint: row.sellingPoint,
    scene: row.scene,
    status: row.status,
    error: row.error ?? undefined,
    versions: row.versions
      .slice()
      .sort((a, b) => a.index - b.index)
      .map(serializeVersion),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : undefined,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : undefined,
    durationMs: row.durationMs ?? undefined,
  });
}

export function serializeProject(row: {
  id: string;
  workspaceId: string;
  name: string;
  campaign: string | null;
  product: string | null;
  channel: string | null;
  createdAt: Date;
  // BrandAI Campaign 业务字段（DB 列存在；旧行用默认值兜底）
  status?: string | null;
  progress?: number | null;
  description?: string | null;
  coverImage?: string | null;
  tags?: string[] | null;
  channels?: string[] | null;
  startDate?: Date | null;
  endDate?: Date | null;
  aiSummary?: string | null;
}): Project {
  return Project.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    campaign: row.campaign ?? undefined,
    product: row.product ?? undefined,
    channel: row.channel ?? undefined,
    createdAt: row.createdAt.toISOString(),
    status: row.status ?? undefined,
    progress: row.progress ?? undefined,
    description: row.description ?? undefined,
    coverImage: row.coverImage ?? undefined,
    tags: row.tags ?? undefined,
    channels: row.channels ?? undefined,
    startDate: row.startDate ? row.startDate.toISOString() : undefined,
    endDate: row.endDate ? row.endDate.toISOString() : undefined,
    aiSummary: row.aiSummary ?? undefined,
  });
}

/**
 * A single generation with all its versions (sorted by `index`).
 * Returns null if it does not exist. Callers must enforce ownership.
 */
export async function getGeneration(
  id: string,
): Promise<Generation | null> {
  const row = await prisma.generation.findUnique({
    where: { id },
    include: { versions: true },
  });
  return row ? serializeGeneration(row) : null;
}

/**
 * A single GenerationVersion by id, shaped to contracts. Returns null if
 * it does not exist. Added by M4 (edit) so the editor + edit worker can
 * load the source version without re-reading the table directly; M6 also
 * reads versions through here. Callers must enforce ownership via the
 * owning Generation/workspace.
 */
export async function getVersion(
  id: string,
): Promise<GenerationVersion | null> {
  const row = await prisma.generationVersion.findUnique({
    where: { id },
  });
  return row ? serializeVersion(row) : null;
}

/**
 * The full ancestor → descendant lineage for a version: every version in
 * the same generation, returned sorted by `index` together with the
 * `rootId` of the chain. Lets the M4 editor and M6 show how an edited
 * version descends from the original generation. Callers must enforce
 * ownership of the owning workspace.
 */
export async function getVersionLineage(
  versionId: string,
): Promise<{
  generationId: string;
  rootId: string | null;
  versions: GenerationVersion[];
} | null> {
  const target = await prisma.generationVersion.findUnique({
    where: { id: versionId },
  });
  if (!target) return null;
  const rows = await prisma.generationVersion.findMany({
    where: { generationId: target.generationId },
  });
  const versions = rows
    .map(serializeVersion)
    .sort((a, b) => a.index - b.index);
  const root = versions.find((v) => !v.parentVersionId) ?? null;
  return {
    generationId: target.generationId,
    rootId: root?.id ?? null,
    versions,
  };
}

/**
 * All generations for a project, newest first, each with its versions.
 * Callers must enforce ownership of the owning workspace.
 */
export async function listProjectGenerations(
  projectId: string,
): Promise<Generation[]> {
  const rows = await prisma.generation.findMany({
    where: { projectId },
    include: { versions: true },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(serializeGeneration);
}

/**
 * Persist a post-generation recheck `ComplianceReport` onto a version's
 * `GenerationVersion.complianceReport` (Json, nullable). Added by M5 — the
 * recheck route is the only writer of this column (M3/M4 leave it null).
 * Returns the refreshed version shaped to contracts. Callers must enforce
 * ownership of the owning workspace. (Additive — existing exports above
 * are unchanged.)
 */
export async function setVersionComplianceReport(
  versionId: string,
  report: ComplianceReportType,
): Promise<GenerationVersion> {
  const row = await prisma.generationVersion.update({
    where: { id: versionId },
    data: { complianceReport: ComplianceReport.parse(report) },
  });
  return serializeVersion(row);
}

/** Projects in a workspace, newest first. */
export async function listWorkspaceProjects(
  workspaceId: string,
): Promise<Project[]> {
  // Exclude the hidden D10 brand-preview bucket (Generation.projectId requires
  // a Project, but it must NOT surface as a user Campaign anywhere this list
  // feeds — Campaign page / homepage / assets join dialog).
  const rows = await prisma.project.findMany({
    where: { workspaceId, name: { not: BRAND_PREVIEW_PROJECT_NAME } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(serializeProject);
}

/**
 * A single project shaped to contracts, scoped to a workspace. Returns
 * null if it does not exist or belongs to another workspace. Added by M6
 * for the project drill-down page. (Additive — existing exports above are
 * unchanged.) Callers must enforce ownership of the owning workspace.
 */
export async function getProject(
  workspaceId: string,
  projectId: string,
): Promise<Project | null> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
  });
  if (!row || row.workspaceId !== workspaceId) return null;
  return serializeProject(row);
}

/** A recent generated thumbnail for the workspace dashboard gallery. */
export type RecentVersion = {
  id: string;
  imageUrl: string;
  width: number;
  height: number;
  sceneType: string;
  generationId: string;
  projectId: string;
  createdAt: string;
};

/**
 * The most recent GenerationVersions whose generation's project belongs to
 * `workspaceId`, newest first. Shaped for the dashboard "最近生成" gallery —
 * just enough to render a thumbnail and link to the owning project. Added so
 * the dashboard surfaces real output instead of feeling empty. (Additive.)
 */
export async function listRecentVersions(
  workspaceId: string,
  limit = 12,
): Promise<RecentVersion[]> {
  const rows = await prisma.generationVersion.findMany({
    where: { generation: { project: { workspaceId } } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      imageUrl: true,
      width: true,
      height: true,
      generationId: true,
      createdAt: true,
      generation: {
        select: { projectId: true, sceneType: true },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    imageUrl: row.imageUrl,
    width: row.width,
    height: row.height,
    sceneType: row.generation.sceneType,
    generationId: row.generationId,
    projectId: row.generation.projectId,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Aggregate counts for the M1 workspace dashboard, computed from M3/M4/M5
 * write outputs. Added by M6 so the dashboard shows real numbers without
 * other modules reaching into the tables. (Additive.)
 */
export async function getWorkspaceStats(workspaceId: string): Promise<{
  assets: number;
  confirmedRules: number;
  generations: number;
  finalVersions: number;
}> {
  const [assets, confirmedRules, generations, finalVersions] =
    await Promise.all([
      prisma.asset.count({ where: { workspaceId } }),
      prisma.brandRule.count({
        where: { workspaceId, status: "CONFIRMED" },
      }),
      prisma.generation.count({ where: { workspaceId } }),
      prisma.generationVersion.count({
        where: { isFinal: true, generation: { workspaceId } },
      }),
    ]);
  return { assets, confirmedRules, generations, finalVersions };
}

/**
 * §2.3 — queue widget data source. Returns ALL active generations
 * (PENDING + RUNNING) first, then the most recent `terminalLimit` terminal
 * rows. Two queries on purpose: a single `take: N` ordered by createdAt would
 * drop a long-running / stuck active row out of the window once N newer
 * terminal rows exist, making `activeCount` wrongly 0 and the widget hide
 * while work is still in flight. Active rows are unbounded (there are never
 * many at once); terminal rows are capped.
 *
 * `progress` is COARSE (status-derived 0 / 50 / 100). Reading exact BullMQ
 * progress would cost one `getJob` per row per poll. The wizard's existing
 * single-job poll (`?jobId=`) keeps the precise live %.
 */
export async function listWorkspaceQueue(
  workspaceId: string,
  terminalLimit = 15,
): Promise<{ items: QueueItem[]; activeCount: number }> {
  const select = {
    id: true,
    status: true,
    sceneType: true,
    createdAt: true,
    startedAt: true,
    finishedAt: true,
    durationMs: true,
    error: true,
    _count: { select: { versions: true } },
  } as const;
  const [active, terminal] = await Promise.all([
    prisma.generation.findMany({
      where: { workspaceId, status: { in: ["PENDING", "RUNNING"] } },
      orderBy: { createdAt: "desc" },
      select,
    }),
    prisma.generation.findMany({
      where: { workspaceId, status: { in: ["SUCCEEDED", "FAILED"] } },
      orderBy: { createdAt: "desc" },
      take: terminalLimit,
      select,
    }),
  ]);
  const toItem = (r: (typeof active)[number]): QueueItem => ({
    id: r.id,
    status: r.status as QueueItem["status"],
    progress:
      r.status === "SUCCEEDED" ? 100 : r.status === "RUNNING" ? 50 : 0,
    sceneType: r.sceneType as QueueItem["sceneType"],
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt ? r.startedAt.toISOString() : undefined,
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : undefined,
    durationMs: r.durationMs ?? undefined,
    versionCount: r._count.versions,
    error: r.error ?? undefined,
  });
  // Active-first (already the desired order from the two ordered queries).
  const items = [...active.map(toItem), ...terminal.map(toItem)];
  return { items, activeCount: active.length };
}

/**
 * §2.4 (server side) — fail generations stuck in PENDING/RUNNING past
 * `maxAgeMs`. These are orphans: a worker crash or a Redis flush drops the
 * BullMQ job while the row stays PENDING forever, so it would spin in the
 * queue widget with no one to finish it. The generate watchdog already FAILs
 * a genuinely-running job at 5 min, so anything still PENDING/RUNNING past
 * 10 min has definitely lost its job. Called on worker boot + on an interval
 * (see workers/index.ts). Best-effort, idempotent, returns the count swept.
 */
export async function sweepStaleGenerations(
  maxAgeMs = 10 * 60_000,
): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const res = await prisma.generation.updateMany({
    where: {
      status: { in: ["PENDING", "RUNNING"] },
      createdAt: { lt: cutoff },
    },
    data: {
      status: "FAILED",
      error: "任务丢失(worker 重启或超时),请重试",
      finishedAt: new Date(),
    },
  });
  return res.count;
}

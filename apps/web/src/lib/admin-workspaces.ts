import { prisma } from "@brandai/db";
import type {
  AdminWorkspaceDetail,
  AdminWorkspaceSummary,
} from "@brandai/contracts";
import { ApiException } from "@/lib/api";

/**
 * Platform admin — global, read-only view of every brand workspace (across all
 * owners). Read-only: there are no admin write routes for workspace content,
 * the operator just inspects what users have built. Cheap enough unpaginated at
 * this scale (one query + grouped counts).
 */
export async function listAllWorkspaces(): Promise<AdminWorkspaceSummary[]> {
  const workspaces = await prisma.brandWorkspace.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      industry: true,
      ownerId: true,
      createdAt: true,
      owner: { select: { email: true, name: true } },
      _count: {
        select: { assets: true, rules: true, projects: true },
      },
    },
  });

  // generationCount and memberCount aren't direct relations on BrandWorkspace
  // (Generation carries workspaceId; Membership is keyed by workspaceId), so
  // count them with grouped queries and join in memory.
  const [genGroups, memberGroups] = await Promise.all([
    prisma.generation.groupBy({
      by: ["workspaceId"],
      _count: { _all: true },
    }),
    prisma.membership.groupBy({
      by: ["workspaceId"],
      _count: { _all: true },
    }),
  ]);
  const genByWs = new Map(genGroups.map((g) => [g.workspaceId, g._count._all]));
  const memberByWs = new Map(
    memberGroups.map((g) => [g.workspaceId, g._count._all]),
  );

  return workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    ...(w.industry ? { industry: w.industry } : {}),
    ownerId: w.ownerId,
    ownerEmail: w.owner.email,
    ...(w.owner.name ? { ownerName: w.owner.name } : {}),
    createdAt: w.createdAt.toISOString(),
    assetCount: w._count.assets,
    ruleCount: w._count.rules,
    projectCount: w._count.projects,
    generationCount: genByWs.get(w.id) ?? 0,
    memberCount: memberByWs.get(w.id) ?? 0,
  }));
}

/**
 * P3+ — "作品广场" feed. Returns the latest N GenerationVersion rows across
 * every workspace, joined with their Workspace + Project + Generation
 * context and resolved appliedRules (id → summary). Admin-only.
 */
export interface AdminWork {
  versionId: string;
  generationId: string;
  projectId: string;
  workspaceId: string;
  workspaceName: string;
  ownerEmail: string;
  projectName: string;
  campaign?: string;
  sceneType: string;
  sellingPoint: string;
  scene: string;
  imageUrl: string;
  width: number;
  height: number;
  index: number;
  isFinal: boolean;
  parentVersionId?: string;
  reviewStatus: string;
  complianceOverall?: "PASS" | "RISK" | "FORBIDDEN";
  complianceScore?: number;
  createdAt: string;
  /** Resolved rules — summary text per appliedRuleId, sorted by rule type. */
  appliedRules: {
    id: string;
    type: string;
    strength: string;
    summary: string;
  }[];
}

export function adminWorkImageUrl(versionId: string, imageUrl: string): string {
  if (!imageUrl.startsWith("data:")) return imageUrl;
  return `/api/admin/works/${encodeURIComponent(versionId)}/image`;
}

export async function listAllWorks(limit = 60): Promise<AdminWork[]> {
  const versions = await prisma.generationVersion.findMany({
    take: limit,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      index: true,
      imageUrl: true,
      width: true,
      height: true,
      isFinal: true,
      parentVersionId: true,
      reviewStatus: true,
      params: true,
      complianceReport: true,
      createdAt: true,
      generation: {
        select: {
          id: true,
          sceneType: true,
          sellingPoint: true,
          scene: true,
          project: {
            select: {
              id: true,
              name: true,
              campaign: true,
              workspace: {
                select: {
                  id: true,
                  name: true,
                  owner: { select: { email: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  // Collect every appliedRuleId / appliedRules id referenced across all
  // versions, then bulk-load BrandRule rows in one query to avoid N+1.
  const ruleIds = new Set<string>();
  for (const v of versions) {
    const params = (v.params ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(params.appliedRuleIds)
      ? (params.appliedRuleIds as string[])
      : Array.isArray(params.appliedRules)
        ? (params.appliedRules as string[])
        : [];
    for (const id of ids) ruleIds.add(id);
  }
  const ruleRows =
    ruleIds.size > 0
      ? await prisma.brandRule.findMany({
          where: { id: { in: [...ruleIds] } },
          select: {
            id: true,
            type: true,
            strength: true,
            summary: true,
          },
        })
      : [];
  const ruleById = new Map(ruleRows.map((r) => [r.id, r]));

  return versions.map((v): AdminWork => {
    const params = (v.params ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(params.appliedRuleIds)
      ? (params.appliedRuleIds as string[])
      : Array.isArray(params.appliedRules)
        ? (params.appliedRules as string[])
        : [];
    const appliedRules = ids
      .map((id) => ruleById.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r);
    const report = (v.complianceReport ?? {}) as Record<string, unknown>;
    const overall = report.overall as AdminWork["complianceOverall"] | undefined;
    const score =
      typeof report.score === "number" ? (report.score as number) : undefined;
    return {
      versionId: v.id,
      generationId: v.generation.id,
      projectId: v.generation.project.id,
      workspaceId: v.generation.project.workspace.id,
      workspaceName: v.generation.project.workspace.name,
      ownerEmail: v.generation.project.workspace.owner.email,
      projectName: v.generation.project.name,
      ...(v.generation.project.campaign
        ? { campaign: v.generation.project.campaign }
        : {}),
      sceneType: v.generation.sceneType,
      sellingPoint: v.generation.sellingPoint,
      scene: v.generation.scene,
      imageUrl: adminWorkImageUrl(v.id, v.imageUrl),
      width: v.width,
      height: v.height,
      index: v.index,
      isFinal: v.isFinal,
      ...(v.parentVersionId ? { parentVersionId: v.parentVersionId } : {}),
      reviewStatus: v.reviewStatus,
      ...(overall ? { complianceOverall: overall } : {}),
      ...(score != null ? { complianceScore: score } : {}),
      createdAt: v.createdAt.toISOString(),
      appliedRules,
    };
  });
}

/** Full read-only payload for /admin/workspaces/[wsId]. 404 when missing. */
export async function getWorkspaceDetailForAdmin(
  workspaceId: string,
): Promise<AdminWorkspaceDetail> {
  const ws = await prisma.brandWorkspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      industry: true,
      websiteUrl: true,
      ownerId: true,
      createdAt: true,
      owner: { select: { email: true, name: true } },
      rules: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          type: true,
          status: true,
          strength: true,
          summary: true,
        },
      },
      projects: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          campaign: true,
          createdAt: true,
          generations: {
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              sceneType: true,
              sellingPoint: true,
              status: true,
              createdAt: true,
              versions: {
                orderBy: { index: "asc" },
                select: {
                  id: true,
                  imageUrl: true,
                  width: true,
                  height: true,
                  isFinal: true,
                  reviewStatus: true,
                  createdAt: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!ws) throw new ApiException(404, "Workspace not found");

  const members = await prisma.membership.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: {
      userId: true,
      role: true,
      user: { select: { email: true, name: true } },
    },
  });

  return {
    id: ws.id,
    name: ws.name,
    ...(ws.industry ? { industry: ws.industry } : {}),
    ...(ws.websiteUrl ? { websiteUrl: ws.websiteUrl } : {}),
    ownerId: ws.ownerId,
    ownerEmail: ws.owner.email,
    ...(ws.owner.name ? { ownerName: ws.owner.name } : {}),
    createdAt: ws.createdAt.toISOString(),
    members: members.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      ...(m.user.name ? { name: m.user.name } : {}),
      role: m.role,
    })),
    rules: ws.rules.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      strength: r.strength,
      summary: r.summary,
    })),
    projects: ws.projects.map((p) => ({
      id: p.id,
      name: p.name,
      ...(p.campaign ? { campaign: p.campaign } : {}),
      createdAt: p.createdAt.toISOString(),
      generations: p.generations.map((g) => ({
        id: g.id,
        sceneType: g.sceneType,
        sellingPoint: g.sellingPoint,
        status: g.status,
        createdAt: g.createdAt.toISOString(),
        images: g.versions.map((v) => ({
          versionId: v.id,
          imageUrl: v.imageUrl,
          width: v.width,
          height: v.height,
          isFinal: v.isFinal,
          reviewStatus: v.reviewStatus,
          createdAt: v.createdAt.toISOString(),
        })),
      })),
    })),
  };
}

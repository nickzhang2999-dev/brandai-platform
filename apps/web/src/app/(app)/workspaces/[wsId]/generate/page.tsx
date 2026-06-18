import { notFound } from "next/navigation";
import { prisma } from "@brandai/db";
import type { BrandRule, Project, RecognizeResponse } from "@brandai/contracts";
import { EditorialHeader } from "@brandai/ui";
import { auth } from "@/auth";
import { getWorkspaceRole } from "@/lib/workspace";
import { listWorkspaceProjects } from "@/lib/generations";
import { serializeRule } from "@/lib/rules";
import { GenerateModes } from "./generate-modes";

export const dynamic = "force-dynamic";

/**
 * M3 · 商业图片生成
 *
 * Replaces the M1 stub. The Server Component does the ownership check and
 * the initial reads (projects + confirmed brand-rule count); the client
 * wizard drives the step flow: pick/create a Project → choose scene type →
 * input selling point + scene → compliance precheck → enqueue the async
 * generate job → multi-version result grid (regenerate / 选择入库).
 *
 * P3.3 — also reads the confirmed rule set and the workspace color system,
 * so the single-mode wizard can render the §6.4 3-column layout
 * (left BrandDNAPanel / center canvas / right rule constraints) with live
 * workspace data rather than placeholders.
 */
export default async function GeneratePage({
  params,
}: {
  params: Promise<{ wsId: string }>;
}) {
  const { wsId } = await params;
  const session = await auth();
  const userId = session!.user!.id;

  const myRole = await getWorkspaceRole(wsId, userId);
  if (!myRole) notFound();

  const [projects, ruleRows] = await Promise.all([
    listWorkspaceProjects(wsId),
    prisma.brandRule.findMany({
      where: { workspaceId: wsId, status: "CONFIRMED" },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const confirmedRules: BrandRule[] = ruleRows.map(serializeRule);
  // Color System is persisted onto the first `color` rule's `value` blob
  // by the recognize worker (Prisma schema is frozen, no dedicated table).
  const colorSystem =
    (confirmedRules.find((r) => r.type === "color")?.value as
      | { colorSystem?: RecognizeResponse["colorSystem"] }
      | undefined)?.colorSystem ?? null;

  return (
    <>
      <EditorialHeader
        eyebrow="M3 · 商业图片生成"
        title="图片生成"
        subtitle="用这套品牌视觉系统生成商业图：单次生成走向导式 4 步;Campaign Kit 一次产出整套渠道物料。生成前合规预检、按品牌规则约束、批量出图、选择入库。"
      />
      <GenerateModes
        wsId={wsId}
        initialProjects={projects as Project[]}
        confirmedRules={confirmedRules}
        colorSystem={colorSystem ?? null}
        myRole={myRole}
      />
    </>
  );
}

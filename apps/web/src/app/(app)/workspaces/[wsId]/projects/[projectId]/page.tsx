import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@brandai/db";
import type { BrandRule } from "@brandai/contracts";
import { EditorialHeader, Button, StyleTag } from "@brandai/ui";
import { auth } from "@/auth";
import {
  getProject,
  listProjectGenerations,
} from "@/lib/generations";
import { serializeRule } from "@/lib/rules";
import { ProjectDetail } from "./project-detail";

export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ wsId: string; projectId: string }>;
}) {
  const { wsId, projectId } = await params;
  const session = await auth();
  const userId = session!.user!.id;

  const workspace = await prisma.brandWorkspace.findUnique({
    where: { id: wsId },
  });
  if (!workspace || workspace.ownerId !== userId) notFound();

  const project = await getProject(wsId, projectId);
  if (!project) notFound();

  const [generations, ruleRows] = await Promise.all([
    listProjectGenerations(projectId),
    // P3.3 — also fetch CONFIRMED rules so VersionCard can resolve
    // appliedRule IDs to readable summaries via ReferenceSourceList.
    prisma.brandRule.findMany({
      where: { workspaceId: wsId, status: "CONFIRMED" },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const confirmedRules: BrandRule[] = ruleRows.map(serializeRule);

  return (
    <div className="mx-auto max-w-6xl">
      <EditorialHeader
        eyebrow="项目生成记录"
        title={project.name}
        subtitle="该项目下的生成记录、版本链路、合规报告与交付包导出。"
        actions={
          <Link href={`/workspaces/${wsId}/projects`}>
            <Button variant="ghost" size="sm">
              返回项目列表
            </Button>
          </Link>
        }
      />
      {project.campaign || project.product || project.channel ? (
        <div className="-mt-4 mb-10 flex flex-wrap gap-2">
          {project.campaign ? (
            <StyleTag>活动 · {project.campaign}</StyleTag>
          ) : null}
          {project.product ? (
            <StyleTag>商品 · {project.product}</StyleTag>
          ) : null}
          {project.channel ? (
            <StyleTag>渠道 · {project.channel}</StyleTag>
          ) : null}
        </div>
      ) : null}
      <ProjectDetail
        wsId={wsId}
        projectId={projectId}
        initialGenerations={generations}
        confirmedRules={confirmedRules}
      />
    </div>
  );
}

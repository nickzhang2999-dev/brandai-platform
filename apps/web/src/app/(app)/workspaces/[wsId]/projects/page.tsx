import { notFound } from "next/navigation";
import { prisma } from "@brandai/db";
import { EditorialHeader } from "@brandai/ui";
import { auth } from "@/auth";
import { listWorkspaceProjects } from "@/lib/generations";
import { ProjectManager } from "./project-manager";

export const dynamic = "force-dynamic";

export default async function ProjectsPage({
  params,
}: {
  params: Promise<{ wsId: string }>;
}) {
  const { wsId } = await params;
  const session = await auth();
  const userId = session!.user!.id;

  const workspace = await prisma.brandWorkspace.findUnique({
    where: { id: wsId },
  });
  if (!workspace || workspace.ownerId !== userId) notFound();

  const projects = await listWorkspaceProjects(wsId);

  return (
    <div className="mx-auto max-w-6xl">
      <EditorialHeader
        eyebrow="项目与版本"
        title="项目与版本"
        subtitle="按品牌 / 活动 / 商品 / 渠道组织生成任务，管理生成记录、最终版与版本对比，导出交付包。"
      />
      <ProjectManager wsId={wsId} initialProjects={projects} />
    </div>
  );
}

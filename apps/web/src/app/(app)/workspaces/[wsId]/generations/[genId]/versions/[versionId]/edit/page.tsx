import { notFound } from "next/navigation";
import { prisma } from "@brandai/db";
import type { GenerationVersion } from "@brandai/contracts";
import { PageHeader } from "@brandai/ui";
import { auth } from "@/auth";
import { getVersion, getVersionLineage } from "@/lib/generations";
import { VersionEditor } from "./version-editor";

export const dynamic = "force-dynamic";

/**
 * M4 · 图片编辑与二次修改
 *
 * Editor surface for an existing GenerationVersion. The Server Component
 * does the ownership check + initial reads (the source version and its
 * lineage); the client editor drives the operation panel (换背景 / 调产品
 * 位置 / 改文字 / 调色 / 增删元素 / 扩图 / 局部重绘[框选区域] / 多尺寸适配),
 * enqueues the async edit job and shows the new child version once it lands.
 * Every edit creates a NEW GenerationVersion — the original is never
 * overwritten.
 */
export default async function VersionEditPage({
  params,
}: {
  params: Promise<{
    wsId: string;
    genId: string;
    versionId: string;
  }>;
}) {
  const { wsId, genId, versionId } = await params;
  const session = await auth();
  const userId = session!.user!.id;

  const workspace = await prisma.brandWorkspace.findUnique({
    where: { id: wsId },
  });
  if (!workspace || workspace.ownerId !== userId) notFound();

  const generation = await prisma.generation.findUnique({
    where: { id: genId },
  });
  if (!generation || generation.workspaceId !== wsId) notFound();

  const version = await getVersion(versionId);
  if (!version || version.generationId !== genId) notFound();

  const lineage = await getVersionLineage(versionId);

  return (
    <>
      <PageHeader
        eyebrow="M4 · 图片编辑与二次修改"
        title="二次编辑"
        description="对已生成图做二次修改：换背景 / 调产品位置 / 改文字 / 调色 / 增删元素 / 扩图 / 局部重绘（框选区域）/ 多尺寸适配。每次编辑生成一个新版本，原图保留可回溯。"
      />
      <VersionEditor
        wsId={wsId}
        genId={genId}
        sourceVersion={version as GenerationVersion}
        initialLineage={
          lineage as {
            generationId: string;
            rootId: string | null;
            versions: GenerationVersion[];
          }
        }
      />
    </>
  );
}

import { notFound } from "next/navigation";
import { prisma } from "@brandai/db";
import { EditorialHeader } from "@brandai/ui";
import { auth } from "@/auth";
import { AssetLibrary } from "./asset-library";

export const dynamic = "force-dynamic";

export default async function AssetsPage({
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

  return (
    <div className="mx-auto max-w-6xl">
      <EditorialHeader
        eyebrow="M1 · ASSET LIBRARY"
        title="资产库"
        subtitle="上传品牌资产或从官网读取候选素材，分类入库后供 M2 学习与 M3 生成使用。"
      />
      <AssetLibrary
        wsId={wsId}
        defaultWebsiteUrl={workspace.websiteUrl ?? ""}
      />
    </div>
  );
}

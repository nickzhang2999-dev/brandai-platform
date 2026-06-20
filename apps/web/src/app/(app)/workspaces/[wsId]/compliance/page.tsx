import { notFound } from "next/navigation";
import { prisma } from "@brandai/db";
import { EditorialHeader } from "@brandai/ui";
import { auth } from "@/auth";
import { ComplianceTabs } from "./compliance-tabs";

export const dynamic = "force-dynamic";

export default async function CompliancePage({
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
        eyebrow="M5 · 品牌规范校验 + 广告合规"
        title="合规校验"
        subtitle="规则级禁用规范、词级违禁词 + 慎用词、广告法预检三合一；生成前预检与生成后复检共用同一套规则。"
      />
      <ComplianceTabs wsId={wsId} />
    </div>
  );
}

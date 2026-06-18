import { notFound } from "next/navigation";
import { prisma } from "@brandai/db";
import type { Asset, BrandRule } from "@brandai/contracts";
import { EditorialHeader } from "@brandai/ui";
import { auth } from "@/auth";
import { serializeRule } from "@/lib/rules";
import { RuleWorkbench } from "./rule-workbench";

export const dynamic = "force-dynamic";

/**
 * M2 · 品牌风格学习
 *
 * Replaces the M1 stub. Server Component does the ownership check + initial
 * Prisma read; the client workbench handles asset selection, the async
 * recognition job (BullMQ, polled), the evidence-backed confirmation
 * workflow and the Color System report. CONFIRMED rules become the brand
 * rule library read by M3 via `getConfirmedRules` (lib/rules.ts).
 */
export default async function RulesPage({
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

  const [assetRows, ruleRows] = await Promise.all([
    prisma.asset.findMany({
      where: { workspaceId: wsId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.brandRule.findMany({
      where: { workspaceId: wsId },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const assets: Asset[] = assetRows.map((a) => ({
    id: a.id,
    workspaceId: a.workspaceId,
    category: a.category,
    fileName: a.fileName,
    url: a.url,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    source: a.source as Asset["source"],
    createdAt: a.createdAt.toISOString(),
  }));
  const rules: BrandRule[] = ruleRows.map(serializeRule);

  return (
    <div className="mx-auto max-w-6xl">
      <EditorialHeader
        eyebrow="M2 · 品牌风格学习"
        title="风格规则"
        subtitle="从资产库选素材发起 AI 识别，规则不是 AI 随便写的 —— 每条都看证据，再确认 / 修改 / 拒绝并标注强弱。确认后的规则集即该品牌的视觉规则库，供生成调用。"
      />
      <RuleWorkbench
        wsId={wsId}
        initialAssets={assets}
        initialRules={rules}
      />
    </div>
  );
}

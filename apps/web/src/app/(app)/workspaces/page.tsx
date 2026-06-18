import Link from "next/link";
import { prisma } from "@brandai/db";
import { PageHeader, Card, Badge } from "@brandai/ui";
import { auth } from "@/auth";
import { CreateWorkspaceForm } from "./create-workspace-form";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage() {
  const session = await auth();
  const userId = session!.user!.id;

  const workspaces = await prisma.brandWorkspace.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { assets: true, rules: true } } },
  });

  return (
    <>
      <PageHeader
        eyebrow="M1 · Brand Visual Asset Library"
        title="品牌空间"
        description="每个品牌空间是一套独立的视觉资产库与风格规则。先创建空间，再上传资产或读取官网。"
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <Card>
            <div className="mb-4 font-serif text-xl">新建品牌空间</div>
            <CreateWorkspaceForm />
          </Card>
        </div>
        <div className="lg:col-span-2">
          {workspaces.length === 0 ? (
            <Card className="flex h-full items-center justify-center text-sm text-muted-foreground">
              还没有品牌空间，先在左侧创建一个。
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {workspaces.map((ws) => (
                <Link key={ws.id} href={`/workspaces/${ws.id}`}>
                  <Card className="flex h-full flex-col gap-2 transition-colors hover:border-accent">
                    <div className="flex items-center justify-between">
                      <span className="font-serif text-xl">{ws.name}</span>
                      <Badge tone="strong">
                        {ws._count.assets} 资产
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {ws.industry || "未设置行业"}
                    </p>
                    {ws.websiteUrl ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {ws.websiteUrl}
                      </p>
                    ) : null}
                    <p className="mt-auto pt-2 text-xs text-muted-foreground">
                      {ws._count.rules} 条规则 ·{" "}
                      {new Date(ws.createdAt).toLocaleDateString("zh-CN")}
                    </p>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

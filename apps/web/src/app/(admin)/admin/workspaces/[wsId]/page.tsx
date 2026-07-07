import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, CreamCard } from "@brandai/ui";
import { auth } from "@/auth";
import { isAdminUser } from "@/lib/admin";
import { getWorkspaceDetailForAdmin } from "@/lib/admin-workspaces";
import { ApiException } from "@/lib/api";

/**
 * Admin-only — full read-only detail of any workspace: members, confirmed
 * rules, projects and their generated images. Read-only inspection; there is no
 * admin write path into another owner's content.
 */
export default async function AdminWorkspaceDetailPage({
  params,
}: {
  params: Promise<{ wsId: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!(await isAdminUser(session.user.id, session.user.email))) {
    redirect("/workspaces");
  }
  const { wsId } = await params;

  let ws;
  try {
    ws = await getWorkspaceDetailForAdmin(wsId);
  } catch (e) {
    if (e instanceof ApiException && e.status === 404) {
      return (
        <div className="mx-auto max-w-5xl px-6 py-10">
          <Link
            href="/admin/workspaces"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            ← 全部空间
          </Link>
          <p className="mt-8 text-sm text-muted-foreground">空间不存在或已删除。</p>
        </div>
      );
    }
    throw e;
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <Link
        href="/admin/workspaces"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        ← 全部空间
      </Link>
      <div className="mt-3 flex items-center gap-2">
        <h1 className="font-serif text-3xl text-foreground">{ws.name}</h1>
        <Badge tone="weak">只读</Badge>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        所有者 {ws.ownerEmail}
        {ws.ownerName ? `(${ws.ownerName})` : ""} · 创建于{" "}
        {ws.createdAt.slice(0, 10)}
        {ws.industry ? ` · ${ws.industry}` : ""}
        {ws.websiteUrl ? ` · ${ws.websiteUrl}` : ""}
      </p>

      <section className="mt-8">
        <h2 className="font-serif text-xl text-foreground">成员 ({ws.members.length})</h2>
        <CreamCard className="mt-3 flex flex-wrap gap-2 p-4">
          {ws.members.length === 0 ? (
            <span className="text-sm text-muted-foreground">无成员记录</span>
          ) : (
            ws.members.map((m) => (
              <span
                key={m.userId}
                className="inline-flex items-center gap-2 rounded-full border border-foreground/15 px-3 py-1 text-xs"
              >
                <span className="text-foreground">{m.email}</span>
                <Badge tone="neutral">{m.role}</Badge>
              </span>
            ))
          )}
        </CreamCard>
      </section>

      <section className="mt-8">
        <h2 className="font-serif text-xl text-foreground">
          风格规则 ({ws.rules.length})
        </h2>
        <CreamCard className="mt-3 flex flex-col gap-2 p-4">
          {ws.rules.length === 0 ? (
            <span className="text-sm text-muted-foreground">暂无规则</span>
          ) : (
            ws.rules.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-2 border-b border-foreground/5 py-2 text-sm last:border-0"
              >
                <Badge tone="weak">{r.type}</Badge>
                <Badge tone={r.status === "CONFIRMED" ? "pass" : "neutral"}>
                  {r.status}
                </Badge>
                <span className="text-foreground">{r.summary}</span>
              </div>
            ))
          )}
        </CreamCard>
      </section>

      <section className="mt-8">
        <h2 className="font-serif text-xl text-foreground">
          项目与生成 ({ws.projects.length})
        </h2>
        {ws.projects.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">暂无项目。</p>
        ) : (
          <div className="mt-3 flex flex-col gap-6">
            {ws.projects.map((p) => (
              <CreamCard key={p.id} className="p-5">
                <div className="font-medium text-foreground">
                  {p.name}
                  {p.campaign ? (
                    <span className="ml-2 text-xs text-muted-foreground">
                      套组 · {p.campaign}
                    </span>
                  ) : null}
                </div>
                {p.generations.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    该项目暂无生成记录。
                  </p>
                ) : (
                  <div className="mt-3 flex flex-col gap-4">
                    {p.generations.map((g) => (
                      <div key={g.id}>
                        <div className="flex items-center gap-2 text-sm">
                          <Badge tone="weak">{g.sceneType}</Badge>
                          <span className="text-foreground">
                            {g.sellingPoint}
                          </span>
                          <Badge
                            tone={
                              g.status === "SUCCEEDED"
                                ? "pass"
                                : g.status === "FAILED"
                                  ? "danger"
                                  : "neutral"
                            }
                          >
                            {g.status}
                          </Badge>
                        </div>
                        {g.images.length > 0 ? (
                          <div className="mt-2 flex flex-wrap gap-3">
                            {g.images.map((img) => (
                              <div key={img.versionId} className="w-40">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={img.imageUrl}
                                  alt={g.sellingPoint}
                                  className="aspect-square w-40 rounded-lg border border-foreground/10 object-cover"
                                />
                                <div className="mt-1 flex items-center gap-1">
                                  {img.isFinal ? (
                                    <Badge tone="strong">交付版</Badge>
                                  ) : null}
                                  <span className="font-mono text-[10px] text-muted-foreground">
                                    {img.width}×{img.height} · {img.reviewStatus}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </CreamCard>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

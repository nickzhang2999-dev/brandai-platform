import { redirect } from "next/navigation";
import { BrandKnowledgeEditor } from "@/components/brand-knowledge/BrandKnowledgeEditor";
import { knowledgePageLocation } from "@/components/brand-knowledge/knowledge-state";
import { ApiException } from "@/lib/api";
import { studioSession } from "@/lib/studio-session";
import { requireWorkspaceRole } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Same-origin standalone/embedded entry. An explicit invalid workspace never falls back to another brand. */
export default async function StudioBrandKnowledgePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let callback = "/studio";
  let returnUrl = "/studio#/brand";
  try {
    const location = knowledgePageLocation(await searchParams);
    callback = location.callback; returnUrl = location.returnUrl;
    const { user, workspaceId } = await studioSession(new Request("http://novart.internal" + callback));
    const { workspace, role } = await requireWorkspaceRole(workspaceId, user.id, "VIEWER");
    return <main className="min-h-screen bg-background text-foreground" data-testid="studio-brand-knowledge" data-workspace-id={workspaceId}>
      {!location.embedded && <nav className="mx-auto max-w-[880px] px-8 pt-6"><a className="text-sm text-primary underline-offset-4 hover:underline" href={returnUrl}>‹ 返回当前品牌工作台</a></nav>}
      <BrandKnowledgeEditor key={`${workspaceId}:${user.id}`} wsId={workspaceId} brandName={workspace.name} userId={user.id} role={role} embedded={location.embedded} />
    </main>;
  } catch (error) {
    if (error instanceof ApiException && error.status === 401) redirect("/login?callbackUrl=" + encodeURIComponent(callback));
    return <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-foreground">
      <p role="alert" data-testid="studio-knowledge-access-error">{error instanceof ApiException ? error.message : "无法打开此品牌知识库，请从工作台重新选择品牌。"}</p>
      <a className="rounded-full bg-primary px-5 py-2 text-primary-foreground" href={returnUrl} target="_top">返回工作台</a>
    </main>;
  }
}

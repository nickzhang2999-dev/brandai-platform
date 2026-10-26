import { redirect } from "next/navigation";
import { ApiException } from "@/lib/api";
import { studioSession } from "@/lib/studio-session";
import { requireWorkspaceRole } from "@/lib/workspace";
import InspirationClient from "./inspiration-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "设计灵感 · Nova" };

/** A Studio destination, outside the retired BrandAI navigation shell. */
export default async function InspirationPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["workspaceId", "conversationId", "q", "kind", "industry", "medium", "task"]) {
    const value = params[key];
    if (typeof value === "string") query.set(key, value);
  }
  const callback = "/inspiration" + (query.size ? "?" + query : "");
  let returnUrl = "/studio";
  try {
    // Repeated explicit workspace parameters must never select a fallback brand.
    if (Array.isArray(params.workspaceId)) throw new ApiException(400, "品牌参数无效，请从工作台重新打开设计灵感。");
    const { user, workspaceId } = await studioSession(new Request("http://novart.internal" + callback));
    const { workspace } = await requireWorkspaceRole(workspaceId, user.id, "VIEWER");
    returnUrl = "/studio?" + new URLSearchParams({ workspaceId });
    return <main className="min-h-screen bg-background text-foreground" data-testid="studio-inspiration" data-workspace-id={workspaceId}>
      <nav aria-label="设计灵感导航" className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 pt-5 sm:px-8">
        <a className="shrink-0 text-sm text-primary underline-offset-4 hover:underline" href={returnUrl}>‹ 返回 Nova 工作台</a>
        <span className="truncate text-sm text-muted-foreground">{workspace.name}</span>
      </nav>
      <div className="mx-auto max-w-7xl px-5 py-6 sm:px-8"><InspirationClient key={workspaceId} wsId={workspaceId} /></div>
    </main>;
  } catch (error) {
    if (error instanceof ApiException && error.status === 401) redirect("/login?callbackUrl=" + encodeURIComponent(callback));
    return <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-foreground">
      <p role="alert" data-testid="studio-inspiration-access-error">{error instanceof ApiException ? error.message : "无法打开设计灵感，请从工作台重新选择品牌。"}</p>
      <a className="rounded-full bg-primary px-5 py-2 text-primary-foreground" href={returnUrl}>返回 Nova 工作台</a>
    </main>;
  }
}

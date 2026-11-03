/** Only server-validated session workspaces may be passed to this navigation. */
export default function InspirationBrandContext({ workspaceId, workspaceName, workspaces, query }: {
  workspaceId: string;
  workspaceName: string;
  workspaces: Array<{ id: string; name: string; role?: string }>;
  query: string;
}) {
  return <details className="max-w-full rounded-xl border border-border bg-card px-3 py-2 text-sm">
    <summary className="cursor-pointer break-words text-primary">当前品牌：{workspaceName} ▾</summary>
    <p className="mt-2 max-w-sm text-xs text-muted-foreground">选择收藏与项目引用的品牌。同一公司下的品牌共用灵感库；切换后查看所选品牌自己的收藏与对话。</p>
    <ul aria-label="选择引用品牌" className="mt-2 space-y-1">{workspaces.map(brand => {
      const target = new URLSearchParams(query); target.set("workspaceId", brand.id); target.delete("conversationId");
      return <li key={brand.id}><a aria-current={brand.id === workspaceId ? "page" : undefined} className="block break-words rounded-lg px-2 py-2 text-primary hover:bg-accent-soft" href={"/inspiration?" + target}>{brand.name}{brand.id === workspaceId ? " · 当前" : ""}{brand.role === "VIEWER" ? " · 只读" : ""}</a></li>;
    })}</ul>
  </details>;
}

"use client";

import { useQuery } from "@tanstack/react-query";
import type { WorkbenchSession } from "@brandai/contracts";
import { BrandKnowledgeEditor } from "@/components/brand-knowledge/BrandKnowledgeEditor";
import { apiFetch } from "@/lib/client";
import { useBrand } from "../brand-context";

/** Keep the legacy cookie-resolved shell, while the editor itself takes explicit identity/brand props. */
export default function BrandKnowledgePage() {
  const { wsId, brandName, user, refreshBrands } = useBrand();
  const access = useQuery({
    queryKey: ["knowledge-access", wsId, user.id],
    queryFn: () => apiFetch<WorkbenchSession>("/api/workbench/session?" + new URLSearchParams({ workspaceId: wsId })),
  });
  const role = access.data?.workspaces.find(workspace => workspace.id === wsId)?.role;
  if (access.isLoading) return <p role="status" className="p-8 text-sm text-muted-foreground">正在读取品牌权限…</p>;
  if (access.error || !role || access.data?.activeWorkspaceId !== wsId || access.data.user.id !== user.id) {
    return <div className="p-8"><p role="alert" className="text-sm text-destructive">{access.error instanceof Error ? access.error.message : "账号或品牌已变化，请重新打开页面。"}</p><button type="button" className="mt-3 text-primary underline" onClick={() => window.location.reload()}>重新打开</button></div>;
  }
  return <BrandKnowledgeEditor key={`${wsId}:${user.id}`} wsId={wsId} brandName={brandName} userId={user.id} role={role} onBrandChanged={refreshBrands} />;
}

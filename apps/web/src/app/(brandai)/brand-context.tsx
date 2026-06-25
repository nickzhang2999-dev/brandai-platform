"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { BrandWorkspace } from "@brandai/contracts";
import { apiFetch } from "@/lib/client";
import {
  ACTIVE_BRAND_COOKIE,
  ACTIVE_BRAND_COOKIE_MAX_AGE,
} from "@/lib/brand-cookie";

/**
 * 当前品牌（workspace）上下文。由 (brandai)/layout 服务端解析后注入，客户端
 * 页面用 useBrand() 拿到 wsId 去调 workspace 作用域的 BFF 接口。
 */
export interface BrandCtx {
  wsId: string;
  brandName: string;
  user: { name: string; email: string; initial: string };
  knowledgeBases: BrandWorkspace[];
  switchKnowledgeBase: (workspaceId: string) => void;
  createKnowledgeBase: (input: {
    name: string;
    industry?: string;
  }) => Promise<BrandWorkspace>;
}

const Ctx = createContext<BrandCtx | null>(null);
type InitialBrandCtx = Pick<BrandCtx, "wsId" | "brandName" | "user">;

export function BrandProvider({
  value,
  children,
}: {
  value: InitialBrandCtx;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [knowledgeBases, setKnowledgeBases] = useState<BrandWorkspace[]>([]);
  // Initial active id comes from the server (it resolved ACTIVE_BRAND_COOKIE and
  // re-validated membership), so the cookie — not client state — is the single
  // source of truth for "current tenant".
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(value.wsId);

  useEffect(() => {
    let cancelled = false;
    apiFetch<BrandWorkspace[]>("/api/workspaces")
      .then((bases) => {
        if (!cancelled) setKnowledgeBases(bases);
      })
      .catch(() => {
        // Keep the server-resolved workspace usable when the list is unavailable.
        if (!cancelled) setKnowledgeBases([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const switchKnowledgeBase = useCallback(
    (workspaceId: string) => {
      if (workspaceId === activeWorkspaceId) return;
      // Persist server-readable so SSR / refresh / shared links resolve the same
      // brand (the server re-validates membership before honoring it), then
      // re-render server components so the layout-resolved brand stays in sync.
      setActiveWorkspaceId(workspaceId);
      document.cookie = `${ACTIVE_BRAND_COOKIE}=${encodeURIComponent(
        workspaceId,
      )}; path=/; max-age=${ACTIVE_BRAND_COOKIE_MAX_AGE}; samesite=lax`;
      router.refresh();
    },
    [activeWorkspaceId, router],
  );

  const createKnowledgeBase = useCallback(
    async (input: { name: string; industry?: string }) => {
      const created = await apiFetch<BrandWorkspace>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setKnowledgeBases((bases) => [created, ...bases]);
      switchKnowledgeBase(created.id);
      return created;
    },
    [switchKnowledgeBase],
  );

  const activeBase =
    knowledgeBases.find((base) => base.id === activeWorkspaceId) ??
    knowledgeBases.find((base) => base.id === value.wsId);
  const context = useMemo<BrandCtx>(
    () => ({
      ...value,
      wsId: activeBase?.id ?? activeWorkspaceId,
      brandName: activeBase?.name ?? value.brandName,
      knowledgeBases,
      switchKnowledgeBase,
      createKnowledgeBase,
    }),
    [activeBase, activeWorkspaceId, createKnowledgeBase, knowledgeBases, switchKnowledgeBase, value],
  );

  return <Ctx.Provider value={context}>{children}</Ctx.Provider>;
}

export function useBrand(): BrandCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBrand must be used inside BrandProvider");
  return v;
}

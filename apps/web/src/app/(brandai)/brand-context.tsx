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

  // Single source of truth for "current tenant" is the SERVER value (value.wsId):
  // the layout resolved ACTIVE_BRAND_COOKIE and re-validated access, so we never
  // keep a separate client-side active id that could shadow it. A switch just
  // (re)writes the cookie and refreshes; the new brand surfaces only after the
  // server confirms access. This kills a whole class of dual-source bugs:
  //  - stale brand after an RSC refresh / another tab's switch (no client state);
  //  - a rejected switch (revoked membership / stale list) can't pin the UI to an
  //    inaccessible id — the server simply keeps the previous brand;
  //  - same-brand re-select still re-establishes a cleared/expired cookie.
  const switchKnowledgeBase = useCallback(
    (workspaceId: string) => {
      document.cookie = `${ACTIVE_BRAND_COOKIE}=${encodeURIComponent(
        workspaceId,
      )}; path=/; max-age=${ACTIVE_BRAND_COOKIE_MAX_AGE}; samesite=lax`;
      router.refresh();
    },
    [router],
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

  const activeBase = knowledgeBases.find((base) => base.id === value.wsId);
  const context = useMemo<BrandCtx>(
    () => ({
      ...value,
      wsId: value.wsId,
      brandName: activeBase?.name ?? value.brandName,
      knowledgeBases,
      switchKnowledgeBase,
      createKnowledgeBase,
    }),
    [value, activeBase, knowledgeBases, switchKnowledgeBase, createKnowledgeBase],
  );

  return <Ctx.Provider value={context}>{children}</Ctx.Provider>;
}

export function useBrand(): BrandCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBrand must be used inside BrandProvider");
  return v;
}

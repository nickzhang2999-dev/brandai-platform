"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { BrandWorkspace } from "@brandai/contracts";
import { apiFetch } from "@/lib/client";

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
  const [knowledgeBases, setKnowledgeBases] = useState<BrandWorkspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(value.wsId);

  useEffect(() => {
    let cancelled = false;
    apiFetch<BrandWorkspace[]>("/api/workspaces")
      .then((bases) => {
        if (cancelled) return;
        setKnowledgeBases(bases);
        const saved = window.localStorage.getItem("brandai-active-knowledge-base");
        if (saved && bases.some((base) => base.id === saved)) {
          setActiveWorkspaceId(saved);
        }
      })
      .catch(() => {
        // Keep the server-resolved workspace usable when the list is unavailable.
        if (!cancelled) setKnowledgeBases([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const switchKnowledgeBase = useCallback((workspaceId: string) => {
    setActiveWorkspaceId(workspaceId);
    window.localStorage.setItem("brandai-active-knowledge-base", workspaceId);
  }, []);

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

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  user: { id: string; name: string; email: string; initial: string };
  brands: BrandWorkspace[];
  switchBrand: (workspaceId: string) => void;
  refreshBrands: () => Promise<void>;
  createBrand: (input: {
    name: string;
    industry?: string;
  }) => Promise<BrandWorkspace>;
  updateBrand: (
    workspaceId: string,
    patch: { name?: string; industry?: string; disabled?: boolean },
  ) => Promise<BrandWorkspace>;
  deleteBrand: (workspaceId: string) => Promise<void>;
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
  const searchParams = useSearchParams();
  const explicitWorkspaceId = searchParams.get("workspaceId");
  const pendingWorkspace = explicitWorkspaceId !== null && explicitWorkspaceId !== value.wsId;
  const [workspaceRefreshSlow, setWorkspaceRefreshSlow] = useState(false);
  const [brands, setBrands] = useState<BrandWorkspace[]>([]);

  useEffect(() => {
    // Shared Next layouts can survive a query-only soft navigation. Ask the
    // server to validate the new URL before mounting any brand-scoped page.
    setWorkspaceRefreshSlow(false);
    if (!pendingWorkspace) return;
    router.refresh();
    const timer = setTimeout(() => setWorkspaceRefreshSlow(true), 10000);
    return () => clearTimeout(timer);
  }, [pendingWorkspace, explicitWorkspaceId, router]);

  const refreshBrands = useCallback(async () => {
    const loadedBrands = await apiFetch<BrandWorkspace[]>("/api/workspaces");
    setBrands(loadedBrands);
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch<BrandWorkspace[]>("/api/workspaces")
      .then((loadedBrands) => {
        if (!cancelled) setBrands(loadedBrands);
      })
      .catch(() => {
        // Keep the server-resolved workspace usable when the list is unavailable.
        if (!cancelled) setBrands([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 当前品牌以服务端解析出的 cookie 为准。切换品牌时只写 cookie 并刷新，
  // 防止客户端本地状态把 UI 固定到一个服务端已拒绝访问的 workspace。
  const switchBrand = useCallback(
    (workspaceId: string) => {
      document.cookie = `${ACTIVE_BRAND_COOKIE}=${encodeURIComponent(
        workspaceId,
      )}; path=/; max-age=${ACTIVE_BRAND_COOKIE_MAX_AGE}; samesite=lax`;
      const url = new URL(window.location.href);
      url.searchParams.set("workspaceId", workspaceId);
      // A project belongs to its original brand; never carry it across a switch.
      for (const key of ["projectId", "project", "gen", "generationId", "versionId"]) url.searchParams.delete(key);
      router.replace(url.pathname + url.search + url.hash);
      router.refresh();
    },
    [router],
  );

  const createBrand = useCallback(
    async (input: { name: string; industry?: string }) => {
      const created = await apiFetch<BrandWorkspace>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setBrands((currentBrands) => [created, ...currentBrands]);
      switchBrand(created.id);
      return created;
    },
    [switchBrand],
  );

  const updateBrand = useCallback(
    async (
      workspaceId: string,
      patch: { name?: string; industry?: string; disabled?: boolean },
    ) => {
      const updated = await apiFetch<BrandWorkspace>(
        `/api/workspaces/${workspaceId}`,
        {
          method: "PATCH",
          body: JSON.stringify(patch),
        },
      );
      setBrands((currentBrands) =>
        currentBrands.map((brand) =>
          brand.id === updated.id ? updated : brand,
        ),
      );
      return updated;
    },
    [],
  );

  const deleteBrand = useCallback(
    async (workspaceId: string) => {
      await apiFetch<{ ok: true }>(`/api/workspaces/${workspaceId}`, {
        method: "DELETE",
      });
      const remainingBrands = brands.filter(
        (brand) => brand.id !== workspaceId,
      );
      setBrands(remainingBrands);
      if (workspaceId !== value.wsId) return;
      const nextBrand = remainingBrands[0];
      if (nextBrand) {
        switchBrand(nextBrand.id);
        return;
      }
      document.cookie = `${ACTIVE_BRAND_COOKIE}=; path=/; max-age=0; samesite=lax`;
      const url = new URL(window.location.href);
      for (const key of ["workspaceId", "projectId", "project", "gen", "generationId", "versionId"]) url.searchParams.delete(key);
      router.replace(url.pathname + url.search + url.hash);
      router.refresh();
    },
    [brands, router, switchBrand, value.wsId],
  );

  const activeBase = brands.find((brand) => brand.id === value.wsId);
  const context = useMemo<BrandCtx>(
    () => ({
      ...value,
      wsId: value.wsId,
      brandName: activeBase?.name ?? value.brandName,
      brands,
      switchBrand,
      refreshBrands,
      createBrand,
      updateBrand,
      deleteBrand,
    }),
    [
      activeBase,
      brands,
      createBrand,
      refreshBrands,
      switchBrand,
      updateBrand,
      deleteBrand,
      value,
    ],
  );

  return <Ctx.Provider value={context}>{pendingWorkspace
    ? <div role={workspaceRefreshSlow ? "alert" : "status"} className="p-6 text-muted-foreground">
      {workspaceRefreshSlow ? <>品牌加载尚未完成。<button type="button" className="ml-2 text-primary underline" onClick={() => window.location.reload()}>重新打开</button></> : "正在切换品牌…"}
    </div>
    : children}</Ctx.Provider>;
}

export function useBrand(): BrandCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBrand must be used inside BrandProvider");
  return v;
}

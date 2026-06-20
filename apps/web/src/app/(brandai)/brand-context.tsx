"use client";

import { createContext, useContext } from "react";

/**
 * 当前品牌（workspace）上下文。由 (brandai)/layout 服务端解析后注入，客户端
 * 页面用 useBrand() 拿到 wsId 去调 workspace 作用域的 BFF 接口。
 */
export interface BrandCtx {
  wsId: string;
  brandName: string;
  user: { name: string; email: string; initial: string };
}

const Ctx = createContext<BrandCtx | null>(null);

export function BrandProvider({
  value,
  children,
}: {
  value: BrandCtx;
  children: React.ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBrand(): BrandCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBrand must be used inside BrandProvider");
  return v;
}

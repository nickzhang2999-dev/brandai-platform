"use client";

import { useEffect, useState } from "react";

/**
 * P3.4 · Offline / connectivity banner.
 *
 * Listens to navigator online/offline events and exposes a sticky top banner
 * when connectivity drops. Wraps a global fetch interceptor too: a TypeError
 * from fetch (the shape browsers throw when the network is unreachable) flips
 * the banner on, so users get feedback before the next online/offline event
 * actually fires.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    setOffline(typeof navigator !== "undefined" && navigator.onLine === false);

    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);

    // Global fetch interceptor — catches "Failed to fetch" before the browser
    // reports offline (e.g. captive portal, transient DNS). We don't change
    // the response; we just observe outcomes.
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      try {
        const res = await originalFetch(...args);
        if (navigator.onLine) setOffline(false);
        return res;
      } catch (err) {
        if (err instanceof TypeError) setOffline(true);
        throw err;
      }
    };

    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      window.fetch = originalFetch;
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="sticky top-0 z-50 border-b border-destructive/40 bg-destructive/15 text-destructive">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2 text-sm">
        <span
          aria-hidden
          className="inline-block h-2 w-2 animate-pulse rounded-full bg-destructive"
        />
        <span className="font-medium">网络已断开</span>
        <span className="text-destructive/80">
          连接恢复后,失败任务可点「重试」继续。本地未提交的修改不会丢失。
        </span>
      </div>
    </div>
  );
}

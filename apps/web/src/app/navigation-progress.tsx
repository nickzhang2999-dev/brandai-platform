"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const NAVIGATION_START_EVENT = "brandai:navigation-start";
const MIN_VISIBLE_MS = 180;
const COMPLETE_ANIMATION_MS = 240;
const SAFETY_TIMEOUT_MS = 15_000;

type Phase = "idle" | "loading" | "complete";

/** Start the global route indicator before an imperative router.push(). */
export function startNavigationProgress() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(NAVIGATION_START_EVENT));
  }
}

/**
 * Immediate feedback for App Router navigation.
 *
 * Next.js does not expose route-change events in the App Router. We start on
 * same-origin link clicks (plus the explicit event above) and finish when the
 * authoritative pathname/search params change. A safety timeout prevents a
 * failed navigation from leaving the indicator stuck forever.
 */
export function NavigationProgress() {
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const routeKey = `${pathname}?${searchParams.toString()}`;
  const previousRouteRef = useRef<string | null>(null);
  const phaseRef = useRef<Phase>("idle");
  const startedAtRef = useRef(0);
  const completeTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const safetyTimerRef = useRef<number | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");

  const clearTimer = useCallback((ref: { current: number | null }) => {
    if (ref.current !== null) window.clearTimeout(ref.current);
    ref.current = null;
  }, []);

  const completeNow = useCallback(() => {
    if (phaseRef.current === "idle") return;
    clearTimer(safetyTimerRef);
    phaseRef.current = "complete";
    setPhase("complete");
    clearTimer(hideTimerRef);
    hideTimerRef.current = window.setTimeout(() => {
      phaseRef.current = "idle";
      setPhase("idle");
      hideTimerRef.current = null;
    }, COMPLETE_ANIMATION_MS);
  }, [clearTimer]);

  const finish = useCallback(() => {
    if (phaseRef.current === "idle") return;
    clearTimer(completeTimerRef);
    const elapsed = Date.now() - startedAtRef.current;
    completeTimerRef.current = window.setTimeout(
      completeNow,
      Math.max(0, MIN_VISIBLE_MS - elapsed),
    );
  }, [clearTimer, completeNow]);

  const start = useCallback(() => {
    clearTimer(completeTimerRef);
    clearTimer(hideTimerRef);
    clearTimer(safetyTimerRef);
    startedAtRef.current = Date.now();
    phaseRef.current = "loading";
    setPhase("loading");
    safetyTimerRef.current = window.setTimeout(completeNow, SAFETY_TIMEOUT_MS);
  }, [clearTimer, completeNow]);

  useEffect(() => {
    if (previousRouteRef.current === null) {
      previousRouteRef.current = routeKey;
      return;
    }
    if (previousRouteRef.current !== routeKey) {
      previousRouteRef.current = routeKey;
      finish();
    }
  }, [finish, routeKey]);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const eventTarget = event.target;
      const element =
        eventTarget instanceof Element
          ? eventTarget
          : eventTarget instanceof Node
            ? eventTarget.parentElement
            : null;
      const anchor = element?.closest<HTMLAnchorElement>("a[href]");
      if (
        !anchor ||
        (anchor.target && anchor.target !== "_self") ||
        anchor.hasAttribute("download") ||
        anchor.dataset.navigationProgress === "off"
      ) {
        return;
      }

      const destination = new URL(anchor.href, window.location.href);
      const current = new URL(window.location.href);
      if (destination.origin !== current.origin) return;

      // Hash-only and no-op links never wait for a server navigation.
      if (
        destination.pathname === current.pathname &&
        destination.search === current.search
      ) {
        return;
      }
      start();
    };

    document.addEventListener("click", onDocumentClick, true);
    window.addEventListener(NAVIGATION_START_EVENT, start);
    window.addEventListener("popstate", start);
    return () => {
      document.removeEventListener("click", onDocumentClick, true);
      window.removeEventListener(NAVIGATION_START_EVENT, start);
      window.removeEventListener("popstate", start);
    };
  }, [start]);

  useEffect(
    () => () => {
      clearTimer(completeTimerRef);
      clearTimer(hideTimerRef);
      clearTimer(safetyTimerRef);
    },
    [clearTimer],
  );

  if (phase === "idle") return null;

  return (
    <div
      role="progressbar"
      aria-label="页面加载中"
      aria-valuetext="加载中"
      className="navigation-progress"
      data-phase={phase}
    />
  );
}

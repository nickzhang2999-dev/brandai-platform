function enabled() {
  return typeof document !== "undefined" && !!document.querySelector('[data-testid="owned-editor"][data-delivery-timing="enabled"]');
}
type Start = {
  tick: number;
  wall: number;
  requestId?: string;
  sent: Set<string>;
};
const starts = new Map<string, Start>();
const outputs = new Map<string, Start>();
const frames = new Map<
  string,
  { tick: number; assetId: string; responseEnd?: number }
>();
function keep<T>(map: Map<string, T>, key: string, value: T) {
  if (!map.has(key) && map.size >= 256) map.delete(map.keys().next().value!);
  map.set(key, value);
}
export function trackStudioSubmit(mutation: string, tick: number) {
  if (enabled() && !starts.has(mutation))
    keep(starts, mutation, {
      tick,
      wall: Math.round(performance.timeOrigin + tick),
      sent: new Set<string>(),
    });
}
function report(data: object) {
  const workspace=new URLSearchParams(location.search).get("workspaceId");
  void fetch("/studio/delivery-observation"+(workspace ? "?workspaceId="+encodeURIComponent(workspace) : ""), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    keepalive: true,
  }).catch(() => {});
}
function finish(url: string) {
  const start = outputs.get(url),
    frame = frames.get(url);
  if (
    !start?.requestId ||
    !frame ||
    start.sent.has(url) ||
    frame.tick < start.tick
  )
    return;
  start.sent.add(url);
  report({
    stage: "canvas_visible",
    requestId: start.requestId,
    assetId: frame.assetId,
    clickAt: start.wall,
    durationMs: Math.round(frame.tick - start.tick),
    ...(frame.responseEnd &&
    frame.responseEnd >= start.tick &&
    frame.responseEnd <= frame.tick
      ? { clickToReadableMs: Math.round(frame.responseEnd - start.tick) }
      : {}),
  });
  frames.delete(url);
  outputs.delete(url);
}
export function trackStudioReceipt(
  mutation: string,
  requestId: string,
  results: readonly { url: string }[],
) {
  if (!enabled()) return;
  const start = starts.get(mutation);
  if (!start || performance.now() - start.tick > 3600000) return;
  if (!start.requestId) {
    start.requestId = requestId;
    report({ stage: "click_linked", requestId, clickAt: start.wall });
  }
  if (start.requestId !== requestId) return;
  for (const result of results) {
    const url = new URL(result.url, location.href).href;
    if (!start.sent.has(url)) {
      keep(outputs, url, start);
      finish(url);
    }
  }
}
export function observeStudioImage(node: SVGImageElement): () => void {
  if (!enabled() || !window.IntersectionObserver) return () => {};
  const raw = node.getAttribute("href");
  if (!raw) return () => {};
  const url = new URL(raw, location.href);
  const assetId = url.pathname.match(
    /^\/api\/workspaces\/[^/]+\/assets\/([\w-]+)\/raw$/,
  )?.[1];
  if (url.origin !== location.origin || !assetId) return () => {};
  let disposed = false;
  const cleanup = () => {
    disposed = true;
    observer.disconnect();
    document.removeEventListener("visibilitychange", observe);
  };
  const observer = new IntersectionObserver((entries) => {
    if (!entries.at(-1)?.isIntersecting || document.hidden) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (
          disposed ||
          document.hidden ||
          !node.isConnected ||
          raw !== node.getAttribute("href")
        )
          return;
        const rect = node.getBoundingClientRect(),
          view = node
            .closest('[data-testid="owned-canvas"]')
            ?.getBoundingClientRect();
        if (
          !view ||
          Math.min(view.right, innerWidth, rect.right) <=
            Math.max(view.left, 0, rect.left) ||
          Math.min(view.bottom, innerHeight, rect.bottom) <=
            Math.max(view.top, 0, rect.top)
        )
          return;
        const entry = performance
          .getEntriesByName(url.href, "resource")
          .at(-1) as PerformanceResourceTiming | undefined;
        keep(frames, url.href, {
          tick: performance.now(),
          assetId,
          responseEnd: entry?.responseEnd,
        });
        finish(url.href);
        cleanup();
      }),
    );
  });
  function observe() {
    if (!disposed && !document.hidden) {
      observer.unobserve(node);
      observer.observe(node);
    }
  }
  document.addEventListener("visibilitychange", observe);
  observe();
  return cleanup;
}

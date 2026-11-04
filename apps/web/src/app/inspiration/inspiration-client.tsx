"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import type { InspirationCaseCard, InspirationListResponse, InspirationChatState, InspirationBookmark, InspirationFeedbackList } from "@brandai/contracts";
import { Button } from "@brandai/ui";
import { apiFetch, ApiFetchError } from "@/lib/client";
import { PageHeader } from "@/app/(brandai)/_ui";
import { taxonomy, contentTypes, tagLabel } from "@/lib/inspiration/catalog";
import InspirationSyncStatus from "./inspiration-sync-status";
import InspirationReceive from "./inspiration-receive";

const evidenceLabels: Record<string, string> = { author_statement: "作者自述", media_statement: "媒体观点", visual_observation: "图像观察", analysis_inference: "分析推断" };
const inputClass = "w-full rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const errorText = (error: unknown) => {
  if (error instanceof ApiFetchError) {
    if (error.status === 0) return "网络连接中断，请检查网络后重试。";
    if (error.status >= 500) return "服务暂时不可用，请稍后重试。";
    return error.message;
  }
  // Anything else that reached the browser as a raw transport message would leak
  // an untranslated string like "Failed to fetch" into the page.
  if (error instanceof Error && /failed to fetch|networkerror|load failed|network request failed/i.test(error.message)) return "网络连接中断，请检查网络后重试。";
  return error instanceof Error ? error.message : "暂时无法读取，请重试。";
};
const accessError = (error: unknown) => error instanceof ApiFetchError && [401, 403, 404].includes(error.status);
type CaseSelection = { caseId: string; libraryId?: string };
type SelectedImage = CaseSelection & { imageId: string; revision: number; title: string };
type Filters = { q: string; kind: string; industry: string; medium: string; task: string };
const emptyFilters: Filters = { q: "", kind: "", industry: "", medium: "", task: "" };
function sourceLink(value: string) { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; } }

export default function InspirationClient({ wsId, workspaceName = "当前品牌", canEdit = true }: { wsId: string; workspaceName?: string; canEdit?: boolean }) {
  return <InspirationWorkspace key={wsId} wsId={wsId} workspaceName={workspaceName} canEdit={canEdit} />;
}

function InspirationWorkspace({ wsId, workspaceName, canEdit }: { wsId: string; workspaceName: string; canEdit: boolean }) {
  const params = useSearchParams();
  const cache = useQueryClient();
  const base = `/api/workspaces/${encodeURIComponent(wsId)}/inspiration`;
  const urlFilters = JSON.stringify(Object.fromEntries(Object.keys(emptyFilters).map(key => [key, params.get(key) ?? ""])));
  const [filters, setFilters] = useState<Filters>(() => JSON.parse(urlFilters));
  const [applied, setApplied] = useState<Filters>(() => JSON.parse(urlFilters));
  useEffect(() => { const restored: Filters = JSON.parse(urlFilters); setFilters(restored); setApplied(restored); }, [urlFilters]);
  const [selected, setSelected] = useState<CaseSelection | null>(null);
  const [view, setView] = useState<"cases" | "saved" | "feedback">("cases");
  const [conversationId, setConversationId] = useState<string | null>(params.get("conversationId"));
  const [question, setQuestion] = useState("");
  const [selectedImages, setSelectedImages] = useState<SelectedImage[]>([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [accessRevokedAt, setAccessRevokedAt] = useState(0);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRequest = useRef<{ payloadKey: string; requestId: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const key = ["inspiration", wsId, applied];
  // A full page is ~500KB, so background polling is limited to what the reader
  // can actually see: no timer on a hidden tab, and a slower cadence once the
  // first page is on screen (the release id already gates real changes, and the
  // manual "刷新状态" button covers the impatient case).
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => apiFetch<InspirationListResponse>(`${base}?${new URLSearchParams(applied)}`, { signal, cache: "no-store" }), placeholderData: previous => previous, retry: false, refetchInterval: 300000, refetchIntervalInBackground: false });
  // Later pages are fetched on demand from the cursor the server returned. They
  // are keyed by the same filter set state, so changing filters drops them.
  const [more, setMore] = useState<{ scope: string; cursor: string; cases: InspirationCaseCard[]; hasMore: boolean; nextCursor: string | null }[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [autoLoadBlocked, setAutoLoadBlocked] = useState(false);
  const appliedKey = JSON.stringify(applied);

  // Only a user-initiated filter change should say "updating"; the 60s background
  // poll must not flicker the result line the reader is looking at.
  const appliedRef = useRef(applied);
  const [filterPending, setFilterPending] = useState(false);
  useEffect(() => {
    if (appliedRef.current === applied) return;
    appliedRef.current = applied; setFilterPending(true);
  }, [applied]);
  useEffect(() => { if (filterPending && !list.isFetching) setFilterPending(false); }, [filterPending, list.isFetching]);
  const permissionError = accessError(list.error);
  const accessDenied = permissionError || accessRevokedAt > 0 && list.dataUpdatedAt <= accessRevokedAt;
  const enabled = list.data?.enabled === true && !accessDenied;
  useEffect(() => { if (permissionError) setAccessRevokedAt(list.errorUpdatedAt); }, [permissionError, list.errorUpdatedAt]);
  useEffect(() => { if (enabled && selected) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [enabled, selected]);
  useEffect(() => {
    if (list.data?.enabled !== false && !accessDenied) return;
    setSelected(null); setSelectedImages([]); pendingRequest.current = null; setMessage("");
    // Other filter keys may still hold previously enabled lists. Preserve only
    // disabled status responses, so a URL change cannot revive cached cards.
    if (!accessDenied) cache.removeQueries({ queryKey: ["inspiration", wsId], predicate: query => (query.state.data as InspirationListResponse | undefined)?.enabled !== false });
    for (const prefix of ["inspiration-detail", "inspiration-chat", "inspiration-bookmarks", "inspiration-feedback", "inspiration-projects"]) {
      void cache.cancelQueries({ queryKey: [prefix, wsId] });
      cache.removeQueries({ queryKey: [prefix, wsId] });
    }
  }, [list.data?.enabled, accessDenied, cache, wsId]);
  const bookmarks = useQuery({ queryKey: ["inspiration-bookmarks", wsId], queryFn: ({ signal }) => apiFetch<{ items: InspirationBookmark[] }>(`${base}/bookmarks`, { signal, cache: "no-store" }), retry: false, enabled });
  const detail = useQuery({ queryKey: ["inspiration-detail", wsId, selected, list.data?.activeRelease?.id, list.data?.withdrawalSequence], queryFn: ({ signal }) => apiFetch<InspirationCaseCard>(`${base}/cases/${encodeURIComponent(selected!.caseId)}${selected?.libraryId ? "?" + new URLSearchParams({ libraryId: selected.libraryId }) : ""}`, { signal, cache: "no-store" }), enabled: enabled && Boolean(selected), retry: false });
  const history = useQuery({ queryKey: ["inspiration-chat", wsId, conversationId], queryFn: ({ signal }) => apiFetch<{ items: InspirationChatState[] }>(`${base}/chat?conversationId=${encodeURIComponent(conversationId!)}`, { signal, cache: "no-store" }), enabled: enabled && Boolean(conversationId), retry: false,
    refetchInterval: (q) => q.state.data?.items.some((item) => ["PENDING", "RUNNING"].includes(item.status)) ? 2000 : false });
  const contentEpoch = list.data ? `${list.data.sourceLibrary?.id ?? "legacy"}:${list.data.activeRelease?.id ?? "empty"}:${list.data.withdrawalSequence}` : null;
  const pageScope = JSON.stringify([wsId, appliedKey, contentEpoch, enabled, accessRevokedAt]);
  const activePageScope = useRef(pageScope);
  activePageScope.current = pageScope;
  const pendingPage = useRef<AbortController | null>(null);
  useEffect(() => {
    setMore([]); setLoadingMore(false); setAutoLoadBlocked(false);
    pendingPage.current?.abort(); pendingPage.current = null;
    return () => { pendingPage.current?.abort(); pendingPage.current = null; };
  }, [pageScope]);
  const currentMore = more.filter(page => page.scope === pageScope);
  const previousEpoch = useRef<string | null>(null);
  useEffect(() => {
    if (!contentEpoch) return;
    if (previousEpoch.current && previousEpoch.current !== contentEpoch) {
      setSelectedImages([]);
      for (const prefix of ["inspiration-detail", "inspiration-chat", "inspiration-bookmarks", "inspiration-feedback"]) void cache.invalidateQueries({ queryKey: [prefix, wsId] });
    }
    previousEpoch.current = contentEpoch;
  }, [contentEpoch, cache, wsId]);
  // React Query scopes every response by workspace; no case or conversation is stored in browser persistence.
  const busy = sending || Boolean(history.data?.items.some((item) => ["PENDING", "RUNNING"].includes(item.status)));
  const chatLibraryId = (conversationId ? history.data?.items.at(-1)?.sourceLibrary?.id : undefined) ?? list.data?.sourceLibrary?.id;
  const historyUnconfirmed = Boolean(conversationId && (history.isPending || history.isError));
  function setUrl(values: Record<string, string | null>) { const url = new URL(window.location.href); url.searchParams.set("workspaceId", wsId); for (const [key, value] of Object.entries(values)) { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); } window.history.replaceState(null, "", url); }
  function applyFilters(next: Filters) { const clean = { ...next, q: next.q.trim() }; setFilters(clean); setApplied(clean); setUrl(clean); }
  async function ask() {
    const text = question.trim(); if (!enabled || !canEdit || !text || busy || historyUnconfirmed) return;
    if (chatLibraryId && selectedImages.some(image => image.libraryId && image.libraryId !== chatLibraryId)) {
      setMessage("所选图片与当前对话来自不同灵感库，请开启新对话后选择当前库的图片。"); return;
    }
    const images = selectedImages.map(({ caseId, imageId, revision, libraryId }) => ({ caseId, imageId, revision, ...(libraryId ? { libraryId } : {}) }));
    const payload = { question: text, ...(chatLibraryId ? { libraryId: chatLibraryId } : {}), ...(conversationId ? { conversationId } : {}), ...(images.length ? { selectedImages: images } : {}) };
    const payloadKey = JSON.stringify(payload);
    const previous = pendingRequest.current;
    const request = previous?.payloadKey === payloadKey ? previous : { payloadKey, requestId: crypto.randomUUID() };
    pendingRequest.current = request;
    setSending(true); setMessage("");
    try {
      const result = await apiFetch<{ id: string; conversationId: string }>(`${base}/chat`, { method: "POST", body: JSON.stringify({ ...payload, requestId: request.requestId }) });
      if (!alive.current) return;
      setConversationId(result.conversationId); setUrl({ conversationId: result.conversationId }); setQuestion(""); setSelectedImages([]); pendingRequest.current = null;
      await cache.invalidateQueries({ queryKey: ["inspiration-chat", wsId, result.conversationId] });
    } catch (error) { if (alive.current) setMessage(errorText(error)); }
    finally { if (alive.current) setSending(false); }
  }
  // Every rendered card: the first page plus each explicitly loaded later page,
  // deduplicated by library+case so a case republished mid-walk cannot appear twice.
  const items = (() => {
    const seen = new Set<string>();
    const all = [...(list.data?.cases ?? []), ...currentMore.flatMap(page => page.cases)];
    return all.filter(item => { const id = `${item.libraryId}:${item.caseId}`; if (seen.has(id)) return false; seen.add(id); return true; });
  })();
  const hasMore = (currentMore.length ? currentMore[currentMore.length - 1]!.hasMore : list.data?.hasMore) === true;
  async function loadMore() {
    const cursor = currentMore.length ? currentMore[currentMore.length - 1]!.nextCursor : list.data?.nextCursor;
    if (!cursor || pendingPage.current || !enabled || list.isPlaceholderData || list.isError) return;
    const controller = new AbortController(); pendingPage.current = controller;
    const requestScope = pageScope;
    setAutoLoadBlocked(false); setLoadingMore(true);
    try {
      const page = await apiFetch<InspirationListResponse>(`${base}?${new URLSearchParams({ ...applied, cursor })}`, { cache: "no-store", signal: controller.signal });
      if (!alive.current || controller.signal.aborted || activePageScope.current !== requestScope) return;
      const responseEpoch = `${page.sourceLibrary?.id ?? "legacy"}:${page.activeRelease?.id ?? "empty"}:${page.withdrawalSequence}`;
      if (!page.enabled || responseEpoch !== contentEpoch) { setMore([]); void list.refetch(); return; }
      setMore(previous => [...previous.filter(entry => entry.scope === requestScope), { scope: requestScope, cursor, cases: page.cases, hasMore: page.hasMore === true, nextCursor: page.nextCursor ?? null }]);
    } catch (error) {
      if (alive.current && !controller.signal.aborted && activePageScope.current === requestScope) {
        if (accessError(error)) { setAccessRevokedAt(Date.now()); setMore([]); }
        setAutoLoadBlocked(true); setMessage(errorText(error));
      }
    } finally {
      if (pendingPage.current === controller) { pendingPage.current = null; if (alive.current) setLoadingMore(false); }
    }
  }
  async function cancel(id: string) {
    setCancelling(id); setMessage("");
    try { await apiFetch(`${base}/chat/${encodeURIComponent(id)}/cancel`, { method: "POST" }); await history.refetch(); }
    catch (error) { if (alive.current) setMessage(errorText(error)); }
    finally { if (alive.current) setCancelling(null); }
  }
  // Infinite scroll: when the sentinel below the grid becomes visible, fetch the
  // next page. The button stays as a keyboard/manual fallback and as the
  // no-observer path, so neither is the only way to reach the remaining cases.
  const sentinel = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore || loadingMore || autoLoadBlocked || list.isPlaceholderData || list.isError) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMoreRef.current();
    }, { rootMargin: "200px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, items.length, autoLoadBlocked, list.isPlaceholderData, list.isError]);
  const dirty = JSON.stringify(filters) !== JSON.stringify(applied);
  return <div data-testid="inspiration-page">
    <PageHeader title="统一灵感库" subtitle="浏览已接入的设计案例，用图片与来源理解设计方法，按需收藏到当前品牌或项目。" />
    {list.isPending && <p role="status" className="py-10 text-muted-foreground">正在读取灵感库…</p>}
    {list.isError && <div role="alert" className="rounded-2xl border border-border p-5"><p>{errorText(list.error)}</p><Button className="mt-3" onClick={() => void list.refetch()}>重新读取</Button></div>}
    {accessDenied && !permissionError && <div role="alert" className="rounded-2xl border border-border p-5"><p>当前品牌的灵感库访问权限已失效，请重新读取。</p><Button className="mt-3" onClick={() => void list.refetch()}>重新读取</Button></div>}
    {list.data?.enabled === false && <div role="status" className="rounded-2xl border border-border bg-card p-8"><h2 className="text-lg font-semibold">灵感库尚未开放</h2><p className="mt-2 text-sm text-muted-foreground">接通审核案例后，这里会显示可浏览和引用的设计内容。</p></div>}
    {enabled && list.data && <>
      {list.data.sourceLibrary && <p role="status" className="mb-4 rounded-2xl border border-border bg-card px-4 py-3 text-sm" data-testid="inspiration-library-scope">
        {list.data.sourceLibrary.kind === "SHARED"
          ? "当前为公司共享灵感库：同公司内具有品牌访问权限的成员可浏览，收藏与对话仍按品牌隔离。"
          : "当前为品牌私有灵感库：仅当前品牌成员可浏览，尚未接入公司共享库。切换品牌不会共享这里的案例。"}
      </p>}
      <InspirationReceive key={wsId} wsId={wsId} />
      <p className="mb-3 text-xs leading-5 text-muted-foreground">当前品牌：{workspaceName}。收藏、项目借鉴与对话保留在所选品牌中。{!canEdit && "你在此品牌具有只读权限；收藏与问答需要编辑权限。"}</p>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground"><span>库内 {list.data.caseCount} 个案例</span><span>{list.data.searchMode === "hybrid" ? "关键词与语义检索" : "关键词与标签检索"}</span><button className="text-primary underline" onClick={() => { void list.refetch(); void bookmarks.refetch(); void cache.invalidateQueries({ queryKey: ["inspiration-receive", wsId] }); if (conversationId) void history.refetch(); }}>刷新状态</button><span>读取已同步内容，不会触发新的模型分析。</span></div>
      <InspirationSyncStatus data={list.data} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section aria-label="案例浏览" className="min-w-0">
          <div className="mb-4 flex flex-wrap gap-2"><Button variant={view === "cases" ? "primary" : "outline"} onClick={() => setView("cases")}>全部案例</Button><Button variant={view === "saved" ? "primary" : "outline"} onClick={() => setView("saved")}>我的收藏</Button><Button variant={view === "feedback" ? "primary" : "outline"} onClick={() => setView("feedback")}>案例反馈</Button></div>
          {view === "cases" ? <>
            <form aria-label="筛选灵感案例" className="mb-4 space-y-3" onSubmit={(e) => { e.preventDefault(); applyFilters(filters); }}>
              <div className="flex gap-2"><input aria-label="搜索案例" className={`${inputClass} min-w-0`} value={filters.q} maxLength={300} placeholder="搜索字体、包装、系列设计…" onChange={(e) => setFilters(previous => ({ ...previous, q: e.target.value }))} /><Button type="submit">查找</Button></div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <CatalogSelect label="案例类型" all="全部类型" values={contentTypes} value={filters.kind} onChange={kind => setFilters(previous => ({ ...previous, kind }))} />
                <CatalogSelect label="行业筛选" all="全部行业" values={taxonomy.industry} value={filters.industry} onChange={industry => setFilters(previous => ({ ...previous, industry }))} />
                <CatalogSelect label="媒介筛选" all="全部媒介" values={taxonomy.medium} value={filters.medium} onChange={medium => setFilters(previous => ({ ...previous, medium }))} />
                <CatalogSelect label="设计任务" all="全部任务" values={taxonomy.task} value={filters.task} onChange={task => setFilters(previous => ({ ...previous, task }))} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span role="status">{filterPending ? "正在更新筛选结果…" : `当前显示 ${items.length} 个案例${hasMore ? `（共 ${list.data.matchedCount ?? list.data.caseCount} 个）` : ""}`}</span>{dirty ? <span className="text-primary">筛选条件有改动，点“查找”后生效</span> : null}<button type="button" className="text-primary underline" onClick={() => applyFilters(emptyFilters)}>清除筛选</button></div>
            </form>
            {!items.length && <div className="rounded-2xl border border-dashed border-border p-10 text-center" role="status"><h2 className="font-medium">{list.data.caseCount ? "没有符合这些条件的案例" : "等待第一批审核案例"}</h2><p className="mt-2 text-sm text-muted-foreground">{list.data.caseCount ? "试着减少筛选条件，或换一个关键词。" : "案例完成审核并同步后，会在这里出现图片、中文分析和原始出处。"}</p></div>}
            <div className="grid gap-4 sm:grid-cols-2">{items.map((item) => <CaseTile key={`${item.libraryId}:${item.caseId}`} item={item} onOpen={() => setSelected({ caseId: item.caseId, libraryId: item.libraryId })} />)}</div>
            {hasMore && <div ref={sentinel} className="flex justify-center py-6" data-testid="inspiration-sentinel"><button type="button" className="rounded-full border border-border px-4 py-2 text-xs text-primary disabled:opacity-50" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "正在加载…" : "加载更多案例"}</button></div>}
          </> : view === "feedback" ? <FeedbackQueue base={base} wsId={wsId} onOpen={setSelected} /> : <div className="space-y-3">
            {bookmarks.isPending && <p role="status">正在读取收藏…</p>}
            {bookmarks.isError && <p role="alert">{errorText(bookmarks.error)}</p>}
            {bookmarks.data?.items.length === 0 && <p className="rounded-2xl border border-dashed border-border p-10 text-center text-muted-foreground">尚未收藏案例。打开案例可以记录借鉴点并保存到项目。</p>}
            {!accessError(bookmarks.error) && bookmarks.data?.items.map((item) => <BookmarkRow key={item.id} base={base} canEdit={canEdit} item={item} onOpen={() => setSelected({ caseId: item.caseId, libraryId: item.libraryId ?? item.case?.libraryId })} onChange={() => void bookmarks.refetch()} />)}
          </div>}
        </section>
        <section aria-label="灵感对话" className="rounded-2xl border border-border bg-card p-5 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
          <div className="flex items-center justify-between"><h2 className="font-semibold">灵感助手</h2><button disabled={sending} className="text-xs text-primary disabled:opacity-50" onClick={() => { setConversationId(null); setQuestion(""); setSelectedImages([]); setMessage(""); pendingRequest.current = null; setUrl({ conversationId: null }); }}>新对话</button></div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">描述你想解决的设计问题。回答会引用库里的案例；资料不足时会明确说明。</p>
          {!!selectedImages.length && <div className="mt-3 rounded-xl bg-accent-soft p-3 text-xs"><p>选图追问：本次会发送以下图片（最多 2 张）。</p>{selectedImages.map((image) => <div key={`${image.libraryId}:${image.caseId}:${image.imageId}`} className="mt-2 flex items-center justify-between gap-2"><span>{image.title} · {image.imageId}</span><button aria-label={`取消选择 ${image.imageId}`} className="text-primary underline" onClick={() => setSelectedImages((previous) => previous.filter((entry) => entry !== image))}>移除</button></div>)}</div>}
          <div className="my-5 max-h-[65vh] space-y-4 overflow-y-auto" aria-live="polite">
            {history.isError && <div role="alert"><p>{errorText(history.error)}</p><button className="text-primary underline" onClick={() => void history.refetch()}>重新读取对话</button></div>}
            {!accessError(history.error) && history.data?.items.map((item) => <article key={item.id} className="space-y-3 border-b border-border pb-4"><p className="rounded-xl bg-accent-soft p-3 text-sm">{item.question}</p>
              {["PENDING", "RUNNING"].includes(item.status) ? <div><p className="text-sm text-muted-foreground" role="status">正在整理证据与回答，可以离开页面后继续查看。</p><button className="mt-2 text-xs text-primary underline disabled:opacity-50" disabled={cancelling === item.id} onClick={() => void cancel(item.id)}>{cancelling === item.id ? "正在取消…" : "取消回答"}</button></div> : item.status === "FAILED" ? <p role="alert" className="text-sm text-destructive">{item.error ?? "回答未完成，请稍后重试。"}</p> : <p className="whitespace-pre-wrap text-sm leading-6">{item.answer}</p>}
              {item.citations.map((c, i) => <button key={`${c.libraryId}:${c.caseId}`} className="block text-left text-sm text-primary underline" onClick={() => setSelected({ caseId: c.caseId, libraryId: c.libraryId })}>[{i + 1}] {c.title}</button>)}
            </article>)}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void ask(); }}><textarea aria-label="向灵感助手提问" className={inputClass} rows={4} maxLength={3000} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="例如：找适合年轻茶饮品牌的包装，突出字体，方便扩展口味。" /><p className="my-2 text-xs text-muted-foreground">只发送当前任务需要的资料，不会将整个知识库发送给模型。</p>{chatLibraryId && list.data.sourceLibrary?.id && chatLibraryId !== list.data.sourceLibrary.id && <p className="my-2 text-xs text-muted-foreground">此对话保留原灵感库引用；要讨论公司统一库中的新案例，请开启新对话。</p>}<Button type="submit" disabled={!canEdit || busy || historyUnconfirmed || !question.trim() || !list.data.activeRelease}>{busy ? "处理中…" : "发送"}</Button></form>
          {message && <p role="alert" className="mt-3 text-sm text-destructive">{message}</p>}
        </section>
      </div>
    </>}
    {enabled && <dialog ref={dialogRef} aria-label="案例详情" className="m-auto max-h-[90vh] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto rounded-2xl border border-border bg-card p-6 text-foreground backdrop:bg-foreground/30" onCancel={() => setSelected(null)} onClose={() => setSelected(null)}><button autoFocus className="mb-4 text-sm text-primary underline" onClick={() => setSelected(null)}>关闭详情</button>
      {detail.isPending && <p role="status">正在读取案例…</p>}{detail.isError && <p role="alert">{errorText(detail.error)}</p>}
      {detail.data && !detail.isError && <CaseDetail key={`${detail.data.libraryId}:${detail.data.caseId}:${detail.data.revision}`} base={base} wsId={wsId} workspaceName={workspaceName} canEdit={canEdit} item={detail.data} onSaved={() => void bookmarks.refetch()} selectedImages={selectedImages} onImages={setSelectedImages} />}
    </dialog>}
  </div>;
}

function CatalogSelect({ label, all, values, value, onChange }: { label: string; all: string; values: Record<string, string>; value: string; onChange: (value: string) => void }) {
  return <label className="min-w-0 text-xs text-muted-foreground">{label}<select aria-label={label} className={`${inputClass} mt-1 text-foreground`} value={value} onChange={event => onChange(event.target.value)}><option value="">{all}</option>{value && !Object.hasOwn(values, value) && <option value={value}>未识别的筛选条件</option>}{Object.entries(values).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>;
}
function CaseLabels({ item }: { item: InspirationCaseCard }) {
  return <span className="mt-3 flex flex-wrap gap-1 text-xs"><span className="rounded-full bg-muted px-2 py-1 text-muted-foreground">{contentTypes[item.contentType ?? "unknown"]}</span>{item.taxonomyStatus === "legacy" ? <span className="rounded-full bg-muted px-2 py-1 text-muted-foreground">分类待补审</span> : Object.entries(item.tags).flatMap(([group, tags]) => tags.map(tag => ({ group, tag }))).slice(0, 5).map(({ group, tag }) => <span key={`${group}:${tag}`} className="rounded-full bg-accent-soft px-2 py-1 text-primary">{tagLabel(group, tag)}</span>)}</span>;
}
/**
 * The whole tile is one button, so its own content must stay phrasing content:
 * `div`/`p`/`h3` inside a button is invalid HTML and makes screen readers read
 * the entire card as the button's label. `role="heading"` keeps the outline.
 */
function CaseTile({ item, onOpen }: { item: InspirationCaseCard; onOpen: () => void }) {
  return <button onClick={onOpen} data-testid="inspiration-case" className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card text-left transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><CaseImage url={item.images[0]?.url} title={item.title} /><span className="block p-4"><span className="block text-xs text-muted-foreground">{item.brandOrTeam}</span><span role="heading" aria-level={3} className="mt-1 block font-semibold">{item.title}</span><span className="mt-2 line-clamp-3 block text-sm leading-6 text-muted-foreground">{item.summary}</span><CaseLabels item={item} /></span></button>;
}
function CaseImage({ url, title }: { url?: string; title: string }) {
  const [failed, setFailed] = useState(false);
  return url && !failed ? <img src={url} alt={title} loading="lazy" decoding="async" onError={() => setFailed(true)} className="block aspect-[4/3] w-full bg-muted object-contain" /> : <span className="flex aspect-[4/3] w-full items-center justify-center bg-muted text-xs text-muted-foreground">图片暂不可用，仍可查看文字和来源</span>;
}
function CaseDetail({ base, wsId, workspaceName, canEdit, item, onSaved, selectedImages, onImages }: { base: string; wsId: string; workspaceName: string; canEdit: boolean; item: InspirationCaseCard; onSaved: () => void; selectedImages: SelectedImage[]; onImages: (images: SelectedImage[]) => void }) {
  const [note, setNote] = useState(""); const [projectId, setProjectId] = useState(""); const [saving, setSaving] = useState(false); const [notice, setNotice] = useState("");
  const projects = useQuery({ queryKey: ["inspiration-projects", wsId], queryFn: ({ signal }) => apiFetch<{ id: string; name: string }[]>(`/api/workspaces/${encodeURIComponent(wsId)}/projects`, { signal }), retry: false });
  async function save() { if (!canEdit || saving) return; setSaving(true); setNotice(""); try { await apiFetch(`${base}/bookmarks`, { method: "POST", body: JSON.stringify({ caseId: item.caseId, revision: item.revision, note, ...(item.libraryId ? { libraryId: item.libraryId } : {}), ...(projectId ? { projectId } : {}) }) }); setNotice(`已保存到${workspaceName}${projectId ? "的项目收藏" : "的个人收藏"}，保留案例引用与借鉴点。`); onSaved(); } catch (error) { setNotice(errorText(error)); } finally { setSaving(false); } }
  return <><h2 className="text-2xl font-semibold">{item.title}</h2><p className="mt-1 text-sm text-muted-foreground">{item.brandOrTeam} · 修订 {item.revision}</p><p className="my-4 whitespace-pre-wrap text-sm leading-7">{item.summary}</p><div className="grid gap-3 sm:grid-cols-2">{item.images.map((image) => <CaseImage key={image.imageId} url={image.url} title={item.title} />)}</div>
    <CaseLabels item={item} />
    {item.taxonomyStatus === "legacy" && <p className="mt-2 text-xs text-muted-foreground">这是尚未补充分类审核的旧案例，原图、分析与来源仍可查看。</p>}
    {!item.analysisAllowed && <p className="mt-3 text-xs text-muted-foreground">本案例尚未授权模型分析，可以浏览与收藏，暂不用于助手回答。</p>}
    <CaseFeedback base={base} item={item} />
    {item.analysisAllowed && <fieldset disabled={!canEdit} className="mt-4 rounded-xl border border-border p-3"><legend className="px-1 text-sm font-medium">选图追问</legend><p className="mb-2 text-xs text-muted-foreground">选择后关闭详情，在右侧提问；本次所选图片会发送给模型分析。</p>{item.images.map((image) => { const matches = (entry: SelectedImage) => entry.libraryId === item.libraryId && entry.caseId === item.caseId && entry.imageId === image.imageId; const checked = selectedImages.some((entry) => matches(entry) && entry.revision === item.revision); return <label key={image.imageId} className="mr-4 inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={checked} disabled={!checked && selectedImages.length >= 2} onChange={() => onImages(checked ? selectedImages.filter((entry) => !matches(entry)) : [...selectedImages, { caseId: item.caseId, libraryId: item.libraryId, revision: item.revision, imageId: image.imageId, title: item.title }])} />{image.imageId}</label>; })}</fieldset>}
    <h3 className="mt-6 font-semibold">分析与依据</h3><div className="mt-3 space-y-3">{item.claims.map((claim) => <div key={claim.claimId} className="rounded-xl bg-muted p-3"><span className="text-xs font-medium text-primary">{evidenceLabels[claim.kind]}</span><p className="mt-1 text-sm leading-6">{claim.text}</p><p className="mt-1 text-xs text-muted-foreground">依据：{[...claim.sourceIds, ...claim.imageIds].join("、")}</p></div>)}</div>
    <h3 className="mt-6 font-semibold">原始出处</h3><ul className="mt-2 space-y-2">{item.sources.map((source) => { const url = sourceLink(source.url); return <li key={source.sourceId} className="break-all text-sm">{url ? <a className="text-primary underline" href={url} target="_blank" rel="noopener noreferrer">{source.sourceId} · {url}</a> : "来源地址不可用"}</li>; })}</ul>
    <form className="mt-6 space-y-3 border-t border-border pt-5" onSubmit={(e) => { e.preventDefault(); void save(); }}><h3 className="font-semibold">收藏与项目借鉴</h3><p className="text-sm text-muted-foreground">当前品牌：{workspaceName}。切换品牌请使用页面顶部的品牌选择。</p><label className="block text-sm">保存位置<select aria-label="收藏项目" disabled={!canEdit} className={`${inputClass} mt-1`} value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">当前品牌下的我的收藏</option>{Array.isArray(projects.data) && projects.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{projects.isError && <p className="text-xs text-muted-foreground">项目列表暂不可用，仍可保存到当前品牌下的我的收藏。</p>}<textarea aria-label="案例借鉴点" disabled={!canEdit} className={inputClass} rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="记录你想参考的方法和不打算照搬的部分。" /><p className="text-xs text-muted-foreground">收藏保留引用与批注，不会自动加入画布，也不获得原图下载或生成使用权限。</p>{!canEdit && <p className="text-xs text-muted-foreground">你在此品牌具有只读权限，收藏需要编辑权限。</p>}<Button disabled={!canEdit || saving} type="submit">{saving ? "保存中…" : "保存案例"}</Button>{notice && <p role="status" className="text-sm">{notice}</p>}</form>
  </>;
}
function BookmarkRow({ base, canEdit, item, onOpen, onChange }: { base: string; canEdit: boolean; item: InspirationBookmark; onOpen: () => void; onChange: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <article className="rounded-2xl border border-border bg-card p-4"><button disabled={item.unavailable} className="font-semibold text-primary underline disabled:text-muted-foreground" onClick={onOpen}>{item.case?.title ?? "案例已撤回或不可访问"}</button><p className="mt-2 whitespace-pre-wrap text-sm">{item.note || "尚未记录借鉴点"}</p><p className="mt-2 text-xs text-muted-foreground">保存修订 {item.revision} · {item.projectId ? "项目收藏" : "我的收藏"}{item.unavailable ? " · 保留个人批注" : ""}</p><button className="mt-3 text-xs text-muted-foreground underline disabled:opacity-50" disabled={!canEdit || busy} onClick={async () => { setBusy(true); setError(""); try { await apiFetch(`${base}/bookmarks/${encodeURIComponent(item.id)}`, { method: "DELETE" }); onChange(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }}>移除收藏</button>{error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}</article>;
}

function CaseFeedback({ base, item }: { base: string; item: InspirationCaseCard }) {
  const [kind, setKind] = useState("ANALYSIS_ERROR"); const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  return <details className="mt-4 rounded-xl border border-border p-3"><summary className="cursor-pointer text-sm text-muted-foreground">反馈案例问题</summary><form className="mt-3 space-y-3" onSubmit={async (event) => { event.preventDefault(); if (busy) return; setBusy(true); setNotice(""); try { await apiFetch(`${base}/feedback`, { method: "POST", body: JSON.stringify({ caseId: item.caseId, revision: item.revision, kind, note, ...(item.libraryId ? { libraryId: item.libraryId } : {}) }) }); setNotice("反馈已进入工作区审核队列。"); setNote(""); } catch (error) { setNotice(errorText(error)); } finally { setBusy(false); } }}><select aria-label="反馈类型" className={inputClass} value={kind} onChange={(e) => setKind(e.target.value)}><option value="IRRELEVANT">案例不相关</option><option value="ANALYSIS_ERROR">分析错误</option><option value="UNSUPPORTED_CITATION">引用不支持结论</option><option value="BROKEN_IMAGE">图片失效</option></select><textarea aria-label="反馈说明" className={inputClass} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="描述问题，方便审核人修订。" /><Button type="submit" variant="outline" disabled={busy}>{busy ? "提交中…" : "提交反馈"}</Button>{notice && <p role="status" className="text-sm">{notice}</p>}</form></details>;
}

function FeedbackQueue({ base, wsId, onOpen }: { base: string; wsId: string; onOpen: (selection: CaseSelection) => void }) {
  const [scope, setScope] = useState<"mine" | "review">("mine"); const [error, setError] = useState(""); const [saving, setSaving] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["inspiration-feedback", wsId, scope], queryFn: ({ signal }) => apiFetch<InspirationFeedbackList>(`${base}/feedback?scope=${scope}`, { signal, cache: "no-store" }), retry: false });
  const labels = { IRRELEVANT: "案例不相关", ANALYSIS_ERROR: "分析错误", UNSUPPORTED_CITATION: "引用不支持结论", BROKEN_IMAGE: "图片失效" };
  return <div className="space-y-3"><div className="flex flex-wrap items-center gap-3"><h2 className="font-semibold">{scope === "review" ? "待审核反馈" : "我的反馈"}</h2>{query.data?.canReview && <button className="text-sm text-primary underline" onClick={() => setScope(scope === "mine" ? "review" : "mine")}>{scope === "mine" ? "查看工作区审核队列" : "查看我的反馈"}</button>}</div>{scope === "review" && <p className="text-xs text-muted-foreground">核查内容并在 Omni 修订发布后，可标记已处理；此操作只归档反馈。</p>}{query.isPending && <p role="status">正在读取反馈…</p>}{query.isError && <p role="alert">{errorText(query.error)}</p>}{query.data?.items.length === 0 && <p className="rounded-xl border border-dashed border-border p-8 text-center text-muted-foreground">暂无反馈记录。</p>}{!accessError(query.error) && query.data?.items.map((item) => <article key={item.id} className="rounded-xl border border-border p-4"><button disabled={item.unavailable} className="text-sm font-semibold text-primary underline disabled:text-muted-foreground" onClick={() => onOpen({ caseId: item.caseId, libraryId: item.libraryId })}>{item.caseTitle ?? "案例已更新或不可访问"}</button><p className="mt-2 text-xs text-muted-foreground">{labels[item.kind]} · {item.status === "OPEN" ? "待处理" : "已处理"} · 修订 {item.revision}</p><p className="mt-2 whitespace-pre-wrap text-sm">{item.note || "未补充说明"}</p>{scope === "review" && <button className="mt-3 text-xs text-primary underline disabled:opacity-50" disabled={saving === item.id} onClick={async () => { setSaving(item.id); setError(""); try { await apiFetch(`${base}/feedback/${encodeURIComponent(item.id)}`, { method: "PATCH", body: JSON.stringify({ status: "RESOLVED" }) }); await query.refetch(); } catch (e) { setError(errorText(e)); } finally { setSaving(null); } }}>标记已处理</button>}</article>)}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>;
}

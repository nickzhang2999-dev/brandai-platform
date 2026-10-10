"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOwnedDraftApi, createOwnedDraftSession, emptyOwnedDraft, type OwnedDraftSnapshot, type OwnedDraftValue } from "./owned-draft-api";
export type { OwnedDraftValue } from "./owned-draft-api";

type Options = { workspaceId: string; projectId: string; userId: string; value: OwnedDraftValue; onRestore(value: OwnedDraftValue): void; readOnly?: boolean; frozen?: boolean };
const initial = (): OwnedDraftSnapshot => ({ state: "loading", error: "", ready: false, blocked: true, dirty: false, revision: null, value: emptyOwnedDraft() });

/** Controlled composer fields remain disabled until the server draft restores.
 * No browser storage is an authority and no task/provider is invoked here. */
export function useOwnedDraft(options: Options) {
  const { workspaceId, projectId, userId } = options, identity = JSON.stringify([workspaceId, projectId, userId]);
  const latest = useRef(options); latest.current = options;
  const active = useRef<{ identity: string; session: ReturnType<typeof createOwnedDraftSession>; restored: boolean } | null>(null);
  const [reported, setReported] = useState<{ identity: string; snapshot: OwnedDraftSnapshot }>({ identity, snapshot: initial() });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null), composing = useRef(false);
  const cancelTimer = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  const flush = useCallback(async (keepalive = false) => {
    cancelTimer(); const context = active.current;
    if (!context || context.identity !== identity || !context.restored) throw new Error("需求还未恢复，请稍后再试。");
    if (composing.current) throw new Error("请先完成当前中文输入，再确认保存。");
    if (latest.current.readOnly) { if (context.session.snapshot().dirty) throw new Error("项目当前只读，需求尚未保存。"); return context.session.snapshot().value; }
    context.session.edit(latest.current.value);
    return context.session.flush(keepalive);
  }, [identity, cancelTimer]);
  const schedule = useCallback(() => {
    cancelTimer(); const context = active.current;
    if (!context?.restored || context.identity !== identity || latest.current.readOnly || latest.current.frozen || composing.current) return;
    context.session.edit(latest.current.value);
    if (context.session.snapshot().state === "dirty") timer.current = setTimeout(() => { void flush().catch(() => undefined); }, 700);
  }, [identity, flush, cancelTimer]);

  useEffect(() => {
    let mounted = true;
    const session = createOwnedDraftSession(createOwnedDraftApi(workspaceId, projectId, userId), projectId, snapshot => { if (mounted) setReported({ identity, snapshot }); });
    const context = { identity, session, restored: false }; active.current = context; composing.current = false;
    setReported({ identity, snapshot: initial() });
    void session.load().then(value => { if (mounted && active.current === context) { latest.current.onRestore(value); context.restored = true; } }).catch(() => undefined);
    return () => {
      // The last settled value was copied into the session by the edit effect.
      // Keepalive is a best effort; only a checked receipt can mark it saved.
      mounted = false; cancelTimer();
      if (context.restored && !latest.current.readOnly && !composing.current && session.snapshot().dirty) void session.flush(true).catch(() => undefined);
      if (active.current === context) active.current = null;
    };
  }, [workspaceId, projectId, userId, identity, cancelTimer]);

  useEffect(schedule, [schedule, options.value.prompt, options.value.ratio, options.value.quality, options.value.outputFrameId, options.readOnly, options.frozen]);
  useEffect(() => {
    const closing = (event: BeforeUnloadEvent) => { const state = active.current?.session.snapshot(); if (state?.dirty || composing.current) { event.preventDefault(); event.returnValue = ""; if (!composing.current) void flush(true).catch(() => undefined); } };
    const hiding = () => { if (document.visibilityState === "hidden" && !composing.current) void flush(true).catch(() => undefined); };
    const leaving = () => { if (!composing.current) void flush(true).catch(() => undefined); };
    window.addEventListener("beforeunload", closing); window.addEventListener("pagehide", leaving); document.addEventListener("visibilitychange", hiding);
    return () => { window.removeEventListener("beforeunload", closing); window.removeEventListener("pagehide", leaving); document.removeEventListener("visibilitychange", hiding); };
  }, [flush]);
  const retry = useCallback(async () => {
    const context = active.current;
    if (!context || context.identity !== identity) return;
    if (!context.restored) { const value = await context.session.load(); if (active.current === context) { latest.current.onRestore(value); context.restored = true; } }
    else await flush();
  }, [identity, flush]);
  const snapshot = reported.identity === identity ? reported.snapshot : initial();
  return { ...snapshot, flush: () => flush(), retry, compositionStart: () => { composing.current = true; cancelTimer(); }, compositionEnd: () => { composing.current = false; schedule(); } };
}

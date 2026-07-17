"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Generation } from "@brandai/contracts";
import { apiFetch } from "@/lib/client";

/**
 * V0.0.13 · AI 设计师对话面板（迁移自 prd_agent 视觉创作右侧对话，交互对标
 * Lovart）。
 *
 * 设计要点（两条都是从 prd_agent 的 bug 反推出来的硬约束）：
 *  1. 会话流不建消息表 —— 直接把本项目的 Generation 历史投影成对话
 *     （服务端权威：刷新/换设备/深链回来，会话流从服务端完整恢复）。
 *  2. 展示层与模型层物理分离 —— 气泡只显示 chatContext.displayText（用户
 *     原文）+ 引用图缩略 chip；模型 prompt 由 worker/AI 服务从结构化字段
 *     组装，绝不把 URL/文件名/【引用图片】块拼进可见文本。
 *
 * 图生图 = 引用 1 张图 + 指令；多图生图 = 按序引用 ≤8 张。两者走同一条
 * POST /generations → worker → /images/edits multipart 路径。
 */

export interface ChatImageRef {
  kind: "VERSION" | "ASSET";
  id: string;
  url: string;
}

interface ChatContextShape {
  displayText?: string;
  imageInputs?: { kind: "VERSION" | "ASSET"; id: string; url?: string }[];
}

const MAX_REFS = 8;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ChatPanel({
  wsId,
  projectId,
  sceneType,
  onViewGeneration,
}: {
  wsId: string;
  projectId: string | null;
  sceneType: string;
  /** 点结果图 → 画布回看该次出图 */
  onViewGeneration: (generationId: string) => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [refs, setRefs] = useState<ChatImageRef[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 生成中气泡的「已等待 Xs」计时。
  const [now, setNow] = useState(() => Date.now());

  const { data: history = [] } = useQuery<Generation[]>({
    queryKey: ["brandai-project-gens", wsId, projectId],
    queryFn: () =>
      apiFetch(`/api/workspaces/${wsId}/generations?projectId=${projectId}`),
    enabled: !!projectId,
    // §2.2 — 有活跃出图时轮询；否则静默（服务端状态是权威）。
    refetchInterval: (q) =>
      (q.state.data ?? []).some(
        (g) => g.status === "PENDING" || g.status === "RUNNING",
      )
        ? 3000
        : false,
  });

  const anyActive = history.some(
    (g) => g.status === "PENDING" || g.status === "RUNNING",
  );
  useEffect(() => {
    if (!anyActive) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [anyActive]);

  // 会话流 = 历史出图按时间正序（旧→新，聊天习惯）。
  const thread = useMemo(
    () =>
      history
        .slice()
        .sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        ),
    [history],
  );

  // 可引用候选：历史出图的所有版本（新→旧，去重，上限 24 个缩略图）。
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; url: string }[] = [];
    for (const g of history) {
      for (const v of g.versions ?? []) {
        if (!v.imageUrl || seen.has(v.id)) continue;
        seen.add(v.id);
        out.push({ id: v.id, url: v.imageUrl });
        if (out.length >= 24) return out;
      }
    }
    return out;
  }, [history]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const threadFingerprint = thread
    .map((g) => `${g.id}:${g.status}`)
    .join("|");
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [threadFingerprint]);

  function toggleRef(candidate: { id: string; url: string }) {
    setRefs((prev) => {
      const idx = prev.findIndex(
        (r) => r.kind === "VERSION" && r.id === candidate.id,
      );
      if (idx >= 0) return prev.filter((_, i) => i !== idx);
      if (prev.length >= MAX_REFS) return prev;
      return [...prev, { kind: "VERSION", id: candidate.id, url: candidate.url }];
    });
  }

  async function submit(payload: {
    text: string;
    imageInputs: { kind: "VERSION" | "ASSET"; id: string }[];
  }) {
    if (!projectId) {
      setErr("请先选择项目");
      return;
    }
    setSending(true);
    setErr(null);
    try {
      await apiFetch(`/api/workspaces/${wsId}/generations`, {
        method: "POST",
        body: JSON.stringify({
          projectId,
          sceneType,
          // 用户指令进 sellingPoint（prompt 载体）；展示原文单独走
          // chatDisplayText —— 两层分离，气泡永远只显示后者。
          sellingPoint: payload.text,
          versionCount: 1,
          ...(payload.imageInputs.length > 0
            ? { imageInputs: payload.imageInputs }
            : {}),
          chatDisplayText: payload.text,
        }),
      });
      await qc.invalidateQueries({
        queryKey: ["brandai-project-gens", wsId, projectId],
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "发送失败");
    } finally {
      setSending(false);
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text && refs.length === 0) return;
    await submit({
      text,
      imageInputs: refs.map((r) => ({ kind: r.kind, id: r.id })),
    });
    setDraft("");
    setRefs([]);
    setPickerOpen(false);
  }

  // 失败气泡的重试：用该次出图落库的结构化上下文原样重发。
  async function retry(g: Generation) {
    const ctx = (g.chatContext ?? {}) as ChatContextShape;
    await submit({
      text: ctx.displayText ?? g.sellingPoint ?? "",
      imageInputs: (ctx.imageInputs ?? []).map((r) => ({
        kind: r.kind,
        id: r.id,
      })),
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部 */}
      <div className="shrink-0 pb-3">
        <div className="text-sm font-semibold text-foreground">
          Hi，我是你的 AI 设计师
        </div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          直接输入文字发送即可<strong className="font-medium text-foreground">文生图</strong>
          ；从历史出图选中 1 张即<strong className="font-medium text-foreground">图生图</strong>
          ，多选（≤{MAX_REFS} 张，按选择顺序）即
          <strong className="font-medium text-foreground">多图合成</strong>。
        </p>
      </div>

      {/* 会话流 */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto pr-1"
        style={{ overscrollBehavior: "contain" }}
      >
        {thread.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-dashed border-border bg-background p-4 text-center text-xs leading-relaxed text-muted-foreground">
            还没有对话。
            <br />
            在下方输入设计需求，或选择引用图片开始图生图。
          </div>
        ) : (
          <div className="flex flex-col gap-4 pb-2">
            {thread.map((g) => {
              const ctx = (g.chatContext ?? null) as ChatContextShape | null;
              const displayText = ctx?.displayText ?? g.sellingPoint ?? "";
              const chips = ctx?.imageInputs ?? [];
              const active =
                g.status === "PENDING" || g.status === "RUNNING";
              const elapsedS = Math.max(
                0,
                Math.round((now - new Date(g.createdAt).getTime()) / 1000),
              );
              return (
                <div key={g.id} className="flex flex-col gap-2">
                  {/* 用户气泡 —— 只显示用户原文 + 引用 chip，绝不显示
                      prompt/文件名/URL。 */}
                  <div className="ml-6 self-end rounded-2xl rounded-br-md bg-accent-soft px-3 py-2">
                    {chips.length > 0 ? (
                      <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
                        {chips.map((c, i) => (
                          <span
                            key={`${c.id}-${i}`}
                            className="relative h-10 w-10 overflow-hidden rounded-lg border border-primary/20"
                            title={`引用图片 ${i + 1}`}
                          >
                            {c.url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={c.url}
                                alt={`引用 ${i + 1}`}
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <span className="flex h-full w-full items-center justify-center bg-muted text-[9px] text-muted-foreground">
                                图{i + 1}
                              </span>
                            )}
                            <span className="absolute bottom-0 right-0 rounded-tl-md bg-primary px-1 text-[9px] font-medium text-primary-foreground">
                              {i + 1}
                            </span>
                          </span>
                        ))}
                      </div>
                    ) : null}
                    <div className="whitespace-pre-wrap break-words text-xs text-foreground">
                      {displayText || (
                        <span className="italic text-muted-foreground">
                          （仅引用图片）
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-right text-[10px] text-muted-foreground">
                      {fmtTime(g.createdAt)}
                    </div>
                  </div>

                  {/* 助手气泡 —— 产物即体验：结果图本体，而非状态描述。 */}
                  <div className="mr-6 self-start">
                    {active ? (
                      <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        正在生成… 已等待 {elapsedS}s
                      </div>
                    ) : g.status === "FAILED" ? (
                      <div className="max-w-[240px] rounded-2xl rounded-bl-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                        <div className="text-xs font-medium text-destructive">
                          生成失败
                        </div>
                        <p className="mt-1 break-words text-[11px] leading-relaxed text-destructive/80">
                          {g.error || "未知原因"}
                        </p>
                        <button
                          type="button"
                          onClick={() => void retry(g)}
                          disabled={sending}
                          className="mt-2 rounded-full border border-destructive/40 px-2.5 py-1 text-[11px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
                        >
                          重试
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {(g.versions ?? [])
                          .filter((v) => v.imageUrl)
                          .map((v) => (
                            <button
                              key={v.id}
                              type="button"
                              onClick={() => onViewGeneration(g.id)}
                              title="在画布中查看"
                              className="group relative w-[220px] overflow-hidden rounded-2xl rounded-bl-md border border-border transition-colors hover:border-primary"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={v.imageUrl}
                                alt="生成结果"
                                className="w-full object-cover"
                              />
                              <span className="absolute bottom-1 left-1 rounded-full bg-card/90 px-1.5 py-0.5 text-[10px] text-foreground">
                                {v.width}×{v.height}
                                {chips.length > 0
                                  ? ` · 图生图×${chips.length}`
                                  : ""}
                              </span>
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 引用选择器 */}
      {pickerOpen ? (
        <div className="mt-2 shrink-0 rounded-2xl border border-border bg-background p-2">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              点选历史出图作为引用（按点击顺序，{refs.length}/{MAX_REFS}）
            </span>
            <button
              type="button"
              className="underline"
              onClick={() => setPickerOpen(false)}
            >
              收起
            </button>
          </div>
          {candidates.length === 0 ? (
            <p className="py-2 text-center text-[11px] text-muted-foreground">
              本项目还没有可引用的出图
            </p>
          ) : (
            <div className="flex max-h-[120px] flex-wrap gap-1.5 overflow-y-auto">
              {candidates.map((c) => {
                const ordinal =
                  refs.findIndex(
                    (r) => r.kind === "VERSION" && r.id === c.id,
                  ) + 1;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleRef(c)}
                    className={[
                      "relative h-12 w-12 overflow-hidden rounded-lg border-2 transition-colors",
                      ordinal > 0
                        ? "border-primary"
                        : "border-transparent hover:border-border",
                    ].join(" ")}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={c.url}
                      alt="候选引用"
                      className="h-full w-full object-cover"
                    />
                    {ordinal > 0 ? (
                      <span className="absolute bottom-0 right-0 rounded-tl-md bg-primary px-1 text-[9px] font-medium text-primary-foreground">
                        {ordinal}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* 输入区 */}
      <div className="mt-2 shrink-0">
        {refs.length > 0 ? (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {refs.map((r, i) => (
              <span
                key={`${r.id}-${i}`}
                className="relative h-10 w-10 overflow-hidden rounded-lg border border-primary/30"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={r.url}
                  alt={`引用 ${i + 1}`}
                  className="h-full w-full object-cover"
                />
                <span className="absolute bottom-0 right-0 rounded-tl-md bg-primary px-1 text-[9px] font-medium text-primary-foreground">
                  {i + 1}
                </span>
                <button
                  type="button"
                  aria-label={`移除引用 ${i + 1}`}
                  onClick={() =>
                    setRefs((prev) => prev.filter((_, j) => j !== i))
                  }
                  className="absolute right-0 top-0 rounded-bl-md bg-foreground/70 px-1 text-[9px] text-white"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="rounded-[24px] border border-border bg-background p-2 focus-within:border-primary/40 focus-within:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]">
          <textarea
            value={draft}
            rows={2}
            placeholder="输入设计需求，直接发送即可文生图（Enter 发送，Shift+Enter 换行）"
            className="w-full resize-none bg-transparent px-1 text-xs text-foreground outline-none placeholder:text-muted-foreground"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex items-center justify-between px-1 pt-1">
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              className={[
                "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                pickerOpen || refs.length > 0
                  ? "border-primary/40 bg-accent-soft text-primary"
                  : "border-border text-muted-foreground hover:bg-muted",
              ].join(" ")}
            >
              引用图片{refs.length > 0 ? ` ${refs.length}` : ""}
            </button>
            <div className="flex items-center gap-2">
              {/* 模式指示：让用户明确本次发送会跑哪条链路。 */}
              <span className="text-[10px] text-muted-foreground">
                {refs.length === 0
                  ? "文生图"
                  : refs.length === 1
                    ? "图生图"
                    : `多图合成×${refs.length}`}
              </span>
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending || (!draft.trim() && refs.length === 0)}
                className="rounded-full bg-primary px-3.5 py-1.5 text-[11px] font-medium text-primary-foreground transition-opacity disabled:opacity-50"
              >
                {sending ? "发送中…" : "发送"}
              </button>
            </div>
          </div>
        </div>
        {err ? (
          <p className="mt-1.5 text-[11px] text-destructive">{err}</p>
        ) : null}
      </div>
    </div>
  );
}

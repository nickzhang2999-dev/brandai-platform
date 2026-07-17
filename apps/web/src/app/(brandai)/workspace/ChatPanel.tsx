"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Generation } from "@brandai/contracts";
import { apiFetch } from "@/lib/client";
import {
  buildModelBrief,
  MAX_CHAT_IMAGE_INPUTS,
  parseChatDisplayText,
  serializeComposerTokens,
  type ChatComposerRef,
  type ComposerToken,
} from "@/lib/chat-composer";

/**
 * V0.0.13 · AI 设计师对话面板（迁移自 prd_agent 视觉创作右侧对话，交互对标
 * Lovart）。
 *
 * 设计要点（都是从 prd_agent 的 bug / 用户验收反馈反推出来的硬约束）：
 *  1. 会话流不建消息表 —— 直接把本项目的 Generation 历史投影成对话
 *     （服务端权威：刷新/换设备/深链回来，会话流从服务端完整恢复）。
 *  2. 展示层与模型层物理分离 —— 气泡只显示用户组织的内容（文字 + 行内
 *     图片 chip）；模型 prompt 由 worker/AI 服务从结构化字段组装，绝不把
 *     URL/文件名/【引用图片】块拼进可见文本。
 *  3. V0.0.13b 富文本混排（用户验收反馈）—— 图片 chip 是**文字流的一部分**
 *     （"[chip]拿着[chip]在[chip]的背景里…"），不是文本框上方的一排附件：
 *     contentEditable 输入器在光标处插入行内 chip，线格式用 U+FFFC 标记
 *     chip 位置（见 lib/chat-composer.ts），气泡按标记位置行内还原。
 *
 * 图生图 = 引用 1 张图 + 指令；多图生图 = 按序引用 ≤8 张。两者走同一条
 * POST /generations → worker → /images/edits multipart 路径。
 */

interface ChatContextShape {
  displayText?: string;
  imageInputs?: { kind: "VERSION" | "ASSET"; id: string; url?: string }[];
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 气泡内的行内 chip（缩略图；解析不到图时退化为「图N」中性块）。 */
function InlineChip({
  ordinal,
  url,
}: {
  ordinal: number;
  url?: string;
}) {
  return (
    <span
      title={`引用图片 ${ordinal}`}
      className="mx-0.5 inline-flex translate-y-[6px] items-center overflow-hidden rounded-md border border-primary/25 bg-card align-baseline"
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={`引用 ${ordinal}`}
          className="h-6 w-6 object-cover"
        />
      ) : (
        <span className="flex h-6 w-6 items-center justify-center bg-muted text-[9px] text-muted-foreground">
          图{ordinal}
        </span>
      )}
    </span>
  );
}

/** 用户气泡正文：文字与 chip 按线格式标记位置混排。 */
function UserBubbleContent({
  displayText,
  imageInputs,
}: {
  displayText: string;
  imageInputs: ChatComposerRef[];
}) {
  const segments = parseChatDisplayText(displayText, imageInputs);
  const hasInline = segments.some((s) => s.type === "image");
  return (
    <>
      {/* 兼容早期（无行内标记）的消息：chip 集中显示在正文上方。 */}
      {!hasInline && imageInputs.length > 0 ? (
        <span className="mb-1.5 flex flex-wrap justify-end gap-1.5">
          {imageInputs.map((c, i) => (
            <InlineChip key={`${c.id}-${i}`} ordinal={i + 1} url={c.url} />
          ))}
        </span>
      ) : null}
      <span className="whitespace-pre-wrap break-words text-xs leading-6 text-foreground">
        {segments.map((s, i) =>
          s.type === "text" ? (
            <span key={i}>{s.text}</span>
          ) : (
            <InlineChip key={i} ordinal={s.ordinal} url={s.ref?.url} />
          ),
        )}
        {displayText.trim() === "" && imageInputs.length === 0 ? (
          <span className="italic text-muted-foreground">（空消息）</span>
        ) : null}
      </span>
    </>
  );
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
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [chipCount, setChipCount] = useState(0);
  const [composerEmpty, setComposerEmpty] = useState(true);
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

  /** composer DOM 状态 → chipCount / 是否为空。 */
  const syncComposerState = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    const chips = el.querySelectorAll("[data-chat-chip]").length;
    setChipCount(chips);
    setComposerEmpty(chips === 0 && (el.textContent ?? "").trim() === "");
  }, []);

  /** 在光标处插入一个行内图片 chip（不在输入器内则追加到末尾）。 */
  const insertChip = useCallback(
    (ref: { kind: "VERSION" | "ASSET"; id: string; url: string }) => {
      const el = composerRef.current;
      if (!el) return;
      if (el.querySelectorAll("[data-chat-chip]").length >= MAX_CHAT_IMAGE_INPUTS) {
        setErr(`最多引用 ${MAX_CHAT_IMAGE_INPUTS} 张图片`);
        return;
      }
      setErr(null);
      const chip = document.createElement("span");
      chip.contentEditable = "false";
      chip.dataset.chatChip = "1";
      chip.dataset.kind = ref.kind;
      chip.dataset.id = ref.id;
      chip.dataset.url = ref.url;
      chip.className =
        "mx-0.5 inline-flex translate-y-[6px] select-none items-center gap-1 overflow-hidden rounded-md border border-primary/30 bg-accent-soft pr-1 align-baseline";
      chip.innerHTML =
        `<img src="${ref.url.replace(/"/g, "&quot;")}" alt="引用图片" class="h-6 w-6 object-cover" />` +
        `<span class="max-w-[64px] truncate text-[9px] text-primary">#${ref.id.slice(-4)}</span>` +
        `<button type="button" data-chip-remove="1" aria-label="移除引用" class="text-[10px] leading-none text-primary/70 hover:text-primary">×</button>`;
      const sel = window.getSelection();
      let inserted = false;
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (el.contains(range.commonAncestorContainer)) {
          range.deleteContents();
          range.insertNode(chip);
          range.setStartAfter(chip);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
          inserted = true;
        }
      }
      if (!inserted) el.appendChild(chip);
      el.focus();
      syncComposerState();
    },
    [syncComposerState],
  );

  /** contentEditable DOM → 有序 token 流（文本 / chip / 换行）。 */
  function domToTokens(root: Node): ComposerToken[] {
    const tokens: ComposerToken[] = [];
    const walk = (node: Node, topLevel: boolean) => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent ?? "";
          if (text) tokens.push({ type: "text", text });
          return;
        }
        if (!(child instanceof HTMLElement)) return;
        if (child.dataset.chatChip) {
          tokens.push({
            type: "image",
            ref: {
              kind: (child.dataset.kind === "ASSET" ? "ASSET" : "VERSION"),
              id: child.dataset.id ?? "",
              url: child.dataset.url,
            },
          });
          return;
        }
        if (child.tagName === "BR") {
          tokens.push({ type: "text", text: "\n" });
          return;
        }
        // div/p 行容器（浏览器回车产物）→ 行间补换行。
        if (topLevel && tokens.length > 0) {
          tokens.push({ type: "text", text: "\n" });
        }
        walk(child, false);
      });
    };
    walk(root, true);
    return tokens;
  }

  async function submit(payload: {
    displayText: string;
    imageInputs: ChatComposerRef[];
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
          // 模型层 brief：chip 标记替换为 [图N]（与 multipart 顺序对应）；
          // 展示原文单独走 chatDisplayText —— 两层分离。
          sellingPoint: buildModelBrief(payload.displayText).trim(),
          versionCount: 1,
          ...(payload.imageInputs.length > 0
            ? {
                imageInputs: payload.imageInputs.map((r) => ({
                  kind: r.kind,
                  id: r.id,
                })),
              }
            : {}),
          chatDisplayText: payload.displayText,
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
    const el = composerRef.current;
    if (!el) return;
    const { displayText, imageInputs } = serializeComposerTokens(
      domToTokens(el),
    );
    if (displayText.trim() === "" && imageInputs.length === 0) return;
    await submit({ displayText, imageInputs });
    el.innerHTML = "";
    syncComposerState();
    setPickerOpen(false);
  }

  // 失败气泡的重试：用该次出图落库的结构化上下文原样重发。
  async function retry(g: Generation) {
    const ctx = (g.chatContext ?? {}) as ChatContextShape;
    await submit({
      displayText: ctx.displayText ?? g.sellingPoint ?? "",
      imageInputs: (ctx.imageInputs ?? []).map((r) => ({
        kind: r.kind,
        id: r.id,
        url: r.url,
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
          直接输入文字发送即可
          <strong className="font-medium text-foreground">文生图</strong>
          ；点「引用图片」把图插进文字里（如「把 图1 放在 图2 的背景里」），
          1 张即<strong className="font-medium text-foreground">图生图</strong>
          ，多张（≤{MAX_CHAT_IMAGE_INPUTS}，按插入顺序）即
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
            在下方输入设计需求，或插入引用图片开始图生图。
          </div>
        ) : (
          <div className="flex flex-col gap-4 pb-2">
            {thread.map((g) => {
              const ctx = (g.chatContext ?? null) as ChatContextShape | null;
              const displayText = ctx?.displayText ?? g.sellingPoint ?? "";
              const chips = (ctx?.imageInputs ?? []).map((c) => ({
                kind: c.kind,
                id: c.id,
                url: c.url,
              }));
              const active =
                g.status === "PENDING" || g.status === "RUNNING";
              const elapsedS = Math.max(
                0,
                Math.round((now - new Date(g.createdAt).getTime()) / 1000),
              );
              return (
                <div key={g.id} className="flex flex-col gap-2">
                  {/* 用户气泡 —— 文字与 chip 行内混排，绝不显示
                      prompt/文件名/URL。 */}
                  <div className="ml-6 self-end rounded-2xl rounded-br-md bg-accent-soft px-3 py-2">
                    <UserBubbleContent
                      displayText={displayText}
                      imageInputs={chips}
                    />
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

      {/* 引用选择器：点选 → 插入到输入器光标处（成为文字流的一部分） */}
      {pickerOpen ? (
        <div className="mt-2 shrink-0 rounded-2xl border border-border bg-background p-2">
          <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              点选图片插入到光标处（{chipCount}/{MAX_CHAT_IMAGE_INPUTS}）
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
              {candidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  title="插入到输入框"
                  // 保住 composer 的焦点与光标：点击候选图不抢焦点（编辑器
                  // 工具栏惯例），chip 才能插到用户正在编辑的位置。
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    insertChip({ kind: "VERSION", id: c.id, url: c.url })
                  }
                  className="relative h-12 w-12 overflow-hidden rounded-lg border-2 border-transparent transition-colors hover:border-primary"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={c.url}
                    alt="候选引用"
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* 输入区 —— 富文本混排：图片 chip 藏在文字里。
          pb-12：右下角队列 widget（fixed bottom-4 right-4，§2.3 全局进度面）
          与本面板底部同位；预留安全底距，发送/引用按钮不被折叠态 widget
          头条遮挡（不遮挡原则）。 */}
      <div className="mt-2 shrink-0 pb-12">
        <div className="rounded-[24px] border border-border bg-background p-2 focus-within:border-primary/40 focus-within:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]">
          <div className="relative">
            {composerEmpty ? (
              <span className="pointer-events-none absolute left-1 top-0 text-xs leading-6 text-muted-foreground">
                输入设计需求，可把引用图片插进句子里（Enter 发送，Shift+Enter
                换行）
              </span>
            ) : null}
            <div
              ref={composerRef}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              aria-label="设计需求输入（支持在文字中插入引用图片）"
              data-testid="chat-composer"
              className="min-h-[48px] max-h-[140px] w-full overflow-y-auto px-1 text-xs leading-6 text-foreground outline-none"
              onInput={syncComposerState}
              onClick={(e) => {
                const t = e.target as HTMLElement;
                if (t.closest("[data-chip-remove]")) {
                  t.closest("[data-chat-chip]")?.remove();
                  syncComposerState();
                }
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void send();
                }
              }}
              onPaste={(e) => {
                // 只收纯文本，防止外部富文本/HTML 污染线格式。
                e.preventDefault();
                const text = e.clipboardData.getData("text/plain");
                document.execCommand("insertText", false, text);
              }}
              onDragOver={(e) => {
                if (
                  e.dataTransfer.types.includes("application/x-brandai-version")
                ) {
                  e.preventDefault();
                }
              }}
              onDrop={(e) => {
                const versionId = e.dataTransfer.getData(
                  "application/x-brandai-version",
                );
                if (!versionId) return;
                e.preventDefault();
                const cand = candidates.find((c) => c.id === versionId);
                if (cand) {
                  insertChip({ kind: "VERSION", id: cand.id, url: cand.url });
                }
              }}
            />
          </div>
          <div className="flex items-center justify-between px-1 pt-1">
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              className={[
                "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                pickerOpen || chipCount > 0
                  ? "border-primary/40 bg-accent-soft text-primary"
                  : "border-border text-muted-foreground hover:bg-muted",
              ].join(" ")}
            >
              引用图片{chipCount > 0 ? ` ${chipCount}` : ""}
            </button>
            <div className="flex items-center gap-2">
              {/* 模式指示：让用户明确本次发送会跑哪条链路。 */}
              <span className="text-[10px] text-muted-foreground">
                {chipCount === 0
                  ? "文生图"
                  : chipCount === 1
                    ? "图生图"
                    : `多图合成×${chipCount}`}
              </span>
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending || (composerEmpty && chipCount === 0)}
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

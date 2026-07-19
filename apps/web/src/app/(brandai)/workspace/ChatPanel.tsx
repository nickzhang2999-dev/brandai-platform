"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Generation, WatermarkOverlayInput } from "@brandai/contracts";
import { apiFetch } from "@/lib/client";
import {
  buildModelBrief,
  chipToken,
  MAX_CHAT_IMAGE_INPUTS,
  parseChatDisplayText,
  parseChipTokenText,
  serializeComposerTokens,
  type ChatComposerRef,
  type ComposerToken,
} from "@/lib/chat-composer";

/**
 * V0.0.13c · AI 设计师对话面板 —— 视觉创作 composer 的物理移植
 * （2026-07-18 用户验收：「你需要一比一复刻/物理移植」，本版按从
 * prd_agent AdvancedVisualAgentTab / TwoPhaseRichComposer / ImageChipNode
 * 逐行提取的交互规格实现）：
 *
 *  1. 两阶段选择（TwoPhase）：点选任意图片（画布/变体条/历史条/会话结果图）
 *     → 立即在输入框光标处插入**灰色待选 chip**（bg rgba(156,163,175,.18)，
 *     缩略图/文字 60% 透明）；点击输入区（或再点同一张图 / 发送）→ chip
 *     变**实体色就绪态**。待确认时显示「待确认 N 张 + 清除」徽标，
 *     placeholder 切换为「点击此处确认选择，或继续输入...」。
 *  2. chip 解剖 1:1：inline-flex h-20px gap-4px pad 0 6px 0 4px 圆角 4px；
 *     14×14 缩略图（圆角 3）+ 13px 语义标签（>8 字符截为 6+…，maxWidth 80）。
 *  3. 底栏 1:1：左「1K · 比例」尺寸 chip（弹出 分辨率+比例小矩形网格）；
 *     右 模型 chip + 圆形发送箭头（h-7 w-7 rounded-full）。
 *  4. 会话流只投影**对话来源**（chatContext 存在）的生成——表单历史的
 *     brief 不再"莫名其妙"出现。
 *
 * 展示/模型分层铁律不变：displayText 只存用户内容（U+FFFC 标记 chip 位置），
 * 模型 brief 用 [图N]；绝不把 URL/文件名/引用块拼进可见文本。
 */

export interface ChatInsertRefInput {
  kind: "VERSION" | "ASSET";
  id: string;
  url: string;
  label?: string;
}

/**
 * 页面侧（画布/变体条/历史条）操控 composer 的桥（prd_agent 两阶段语义）：
 *  - pick：点选图片。默认 replace（清掉其它灰待选，再插/保留这张的灰 chip）；
 *    additive=true（Shift/Ctrl/Cmd 点选）= 累加不清旧。已就绪的 chip 不受影响。
 *  - clearPending：点画布空白 = 清所有灰待选（已确认的不动）。
 *  - confirmPending：全部灰待选 → 实体确认。
 */
export interface ChatComposerApi {
  pick: (ref: ChatInsertRefInput, opts?: { additive?: boolean }) => void;
  clearPending: () => void;
  confirmPending: () => void;
}

interface ChatContextShape {
  displayText?: string;
  imageInputs?: { kind: "VERSION" | "ASSET"; id: string; url?: string }[];
}

/** 尺寸 chip 的选项（gpt-image-2 支持的 1K 档三比例）。 */
const SIZE_OPTIONS = [
  { ratio: "1:1", width: 1024, height: 1024 },
  { ratio: "2:3", width: 1024, height: 1536 },
  { ratio: "3:2", width: 1536, height: 1024 },
] as const;

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** chip 标签：>8 字符截为前 6 + …（ImageChipNode.tsx:222 同款）。 */
function chipLabel(raw: string | undefined, fallback: string): string {
  const s = (raw ?? "").trim() || fallback;
  return s.length > 8 ? `${s.slice(0, 6)}…` : s;
}

/** 从一次生成推导语义标签（用户原文优先，剥掉 chip 位置标记）。 */
function labelFromGeneration(g: Generation): string {
  const ctx = (g.chatContext ?? null) as ChatContextShape | null;
  const raw = ctx?.displayText ?? g.sellingPoint ?? "";
  const text = parseChatDisplayText(raw, [])
    .map((s) => (s.type === "text" ? s.text : ""))
    .join("")
    .trim();
  return text || g.scene || "图";
}

/* ---------- chip DOM（物理移植 ImageChipNode 的几何与状态） ---------- */

const CHIP_GRAY_BG = "rgba(156, 163, 175, 0.18)";
const CHIP_GRAY_BORDER = "rgba(156, 163, 175, 0.35)";
// 就绪态用 BrandAI 品牌 violet（源实现为蓝，本仓库品牌色唯一 violet）。
const CHIP_READY_BG = "rgba(124, 92, 255, 0.16)";
const CHIP_READY_BORDER = "rgba(124, 92, 255, 0.4)";

function applyChipReadyStyle(chip: HTMLElement, ready: boolean) {
  chip.dataset.ready = ready ? "1" : "0";
  chip.style.background = ready ? CHIP_READY_BG : CHIP_GRAY_BG;
  chip.style.border = `1px solid ${ready ? CHIP_READY_BORDER : CHIP_GRAY_BORDER}`;
  const img = chip.querySelector("img");
  if (img) (img as HTMLElement).style.opacity = ready ? "1" : "0.6";
  const label = chip.querySelector("[data-chip-label]");
  if (label) (label as HTMLElement).style.opacity = ready ? "0.95" : "0.6";
}

function buildChipElement(ref: ChatInsertRefInput): HTMLElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.chatChip = "1";
  chip.dataset.kind = ref.kind;
  chip.dataset.id = ref.id;
  chip.dataset.url = ref.url;
  chip.dataset.label = ref.label ?? "";
  chip.style.cssText =
    "display:inline-flex;align-items:center;gap:4px;height:20px;" +
    "padding:0 6px 0 4px;margin:0 2px;border-radius:4px;vertical-align:middle;" +
    "cursor:default;user-select:none;";
  const img = document.createElement("img");
  img.src = ref.url;
  img.alt = "引用图片";
  img.style.cssText =
    "width:14px;height:14px;border-radius:3px;object-fit:cover;" +
    "border:1px solid rgba(0,0,0,0.12);";
  const label = document.createElement("span");
  label.dataset.chipLabel = "1";
  label.textContent = chipLabel(ref.label, "图");
  label.style.cssText =
    "font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;" +
    "text-overflow:ellipsis;max-width:80px;color:var(--foreground,#1a1a1f);";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.chipRemove = "1";
  remove.setAttribute("aria-label", "移除引用");
  remove.textContent = "×";
  remove.style.cssText =
    "font-size:11px;line-height:1;color:rgba(124,92,255,0.7);cursor:pointer;" +
    "background:none;border:none;padding:0 0 0 2px;";
  chip.append(img, label, remove);
  applyChipReadyStyle(chip, false);
  return chip;
}

/* ---------- 气泡行内 chip（会话流展示，只读） ---------- */

function InlineChip({ ordinal, url }: { ordinal: number; url?: string }) {
  return (
    <span
      title={`引用图片 ${ordinal}`}
      className="mx-0.5 inline-flex translate-y-[6px] items-center overflow-hidden rounded-md border border-primary/25 bg-card align-baseline"
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={`引用 ${ordinal}`} className="h-6 w-6 object-cover" />
      ) : (
        <span className="flex h-6 w-6 items-center justify-center bg-muted text-[9px] text-muted-foreground">
          图{ordinal}
        </span>
      )}
    </span>
  );
}

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

/* ==================== 面板 ==================== */

export function ChatPanel({
  wsId,
  projectId,
  sceneType,
  onViewGeneration,
  onSubmitted,
  presetBrief,
  watermarkOverlays,
  insertRef,
  onComposerRefsChange,
  onPasteImage,
}: {
  wsId: string;
  projectId: string | null;
  sceneType: string;
  /** 页面侧已配置的水印/logo 叠加（启用且非 REFERENCE 模式）。对话是唯一生成
      入口（生成表单已删），不透传的话已配置水印的 Campaign 出图会静默丢
      logo/水印——worker 对 chat-origin 同样支持确定性合成（Codex P2）。 */
  watermarkOverlays?: WatermarkOverlayInput[];
  onViewGeneration: (generationId: string) => void;
  /** 提交成功后回调（新 generation + jobId）——页面切换选中出图，让新图直接
      落画布轮询，不必等用户手点「查看」（Codex P2）。 */
  onSubmitted?: (generationId: string, jobId: string | null) => void;
  /** 页面侧点选图片（画布/变体条/历史条）→ composer 操控 API 的桥。 */
  insertRef?: MutableRefObject<ChatComposerApi | null>;
  /** 输入框内当前引用（有序 id + 就绪态）变化时回调，供源图显示选中态。 */
  onComposerRefsChange?: (refs: { id: string; ready: boolean }[]) => void;
  /** 输入框内粘贴图片 → 交给页面上传进画布（prd_agent 途径4：图片落画布不落输入框）。 */
  onPasteImage?: (files: File[]) => void;
  /** 首页「开始创作」/模板库经 ?brief= 直达工作台的起始提示词（Codex P2）：
      生成表单已删，brief 落进对话输入框；仅在参数真实变化且输入框为空时播种。 */
  presetBrief?: string | null;
}) {
  const qc = useQueryClient();
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [chipCount, setChipCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [composerEmpty, setComposerEmpty] = useState(true);
  const [sending, setSending] = useState(false);
  // 在途防连击（Codex P2）：contentEditable 里连按 Enter 不经过按钮 disabled，
  // sending state 的闭包也可能滞后一拍——用 ref 做同步闸，杜绝同一份输入
  // 重复 POST /generations（重复扣配额 + 重复起 job）。
  const sendingRef = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  const [sizeOpen, setSizeOpen] = useState(false);
  const [sizeIdx, setSizeIdx] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const { data: history = [] } = useQuery<Generation[]>({
    queryKey: ["brandai-project-gens", wsId, projectId],
    queryFn: () =>
      apiFetch(`/api/workspaces/${wsId}/generations?projectId=${projectId}`),
    enabled: !!projectId,
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

  // 会话流 = **对话来源**的出图（chatContext 存在），旧→新。表单（生成面板）
  // 的历史 brief 不属于对话，不再混入（2026-07-18 用户验收「莫名其妙出现
  // 一段提示词」的修复）。表单历史仍在画布下方「历史出图」条。
  const thread = useMemo(
    () =>
      history
        .filter((g) => !!g.chatContext)
        .sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        ),
    [history],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const threadFingerprint = thread.map((g) => `${g.id}:${g.status}`).join("|");
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [threadFingerprint]);

  /* ---------- composer 状态同步 ---------- */

  const syncComposerState = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    const chips = Array.from(
      el.querySelectorAll<HTMLElement>("[data-chat-chip]"),
    );
    setChipCount(chips.length);
    setPendingCount(chips.filter((c) => c.dataset.ready !== "1").length);
    setComposerEmpty(
      chips.length === 0 && (el.textContent ?? "").trim() === "",
    );
    onComposerRefsChange?.(
      chips.map((c) => ({ id: c.dataset.id ?? "", ready: c.dataset.ready === "1" })),
    );
  }, [onComposerRefsChange]);

  // 首页 brief 播种（Codex P2）：`/workspace?brief=...` 到达时把起始提示词落进
  // 对话输入框——生成表单删除后这是唯一生成入口，否则首页 CTA 的 brief 会被
  // 静默丢弃。仅在 brief 参数真实变化（真导航）且输入框为空时播种，绝不覆盖
  // 用户已输入的内容；播种后同步状态让发送按钮立即可用。
  useEffect(() => {
    const brief = presetBrief?.trim();
    if (!brief) return;
    const el = composerRef.current;
    if (!el) return;
    const hasContent =
      (el.textContent ?? "").trim() !== "" ||
      el.querySelector("[data-chat-chip]") !== null;
    if (hasContent) return;
    el.textContent = brief;
    syncComposerState();
  }, [presetBrief, syncComposerState]);

  /**
   * V0.0.13f — 选区 → chip 文本 token（复制/剪切）。选区含 chip 时返回
   * `文本 + [@image:#N:KIND_id:url]` 混合文本（可粘回本 composer 还原，
   * 也可存到任何地方）；选区不在 composer 内或不含 chip 时返回 null
   * （走浏览器默认复制）。
   */
  const selectionToTokenText = useCallback((): string | null => {
    const el = composerRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return null;
    const frag = range.cloneContents();
    let ordinal = 0;
    let hasChip = false;
    const walk = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
      if (node instanceof HTMLElement && node.dataset.chatChip === "1") {
        hasChip = true;
        ordinal += 1;
        return chipToken(ordinal, {
          kind: (node.dataset.kind === "ASSET" ? "ASSET" : "VERSION") as
            | "VERSION"
            | "ASSET",
          id: node.dataset.id ?? "",
          url: node.dataset.url ?? "",
        });
      }
      let out = "";
      node.childNodes.forEach((c) => {
        out += walk(c);
      });
      return out;
    };
    let out = "";
    frag.childNodes.forEach((c) => {
      out += walk(c);
    });
    return hasChip ? out : null;
  }, []);

  /** 灰色待选 → 全部就绪（TwoPhase confirmPending 的移植）。 */
  const confirmPending = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>('[data-chat-chip][data-ready="0"]').forEach(
      (c) => applyChipReadyStyle(c, true),
    );
    syncComposerState();
  }, [syncComposerState]);

  /** 清除所有待选（灰色）chip。 */
  const clearPending = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>('[data-chat-chip][data-ready="0"]').forEach(
      (c) => c.remove(),
    );
    syncComposerState();
  }, [syncComposerState]);

  /**
   * 点选图片（源自画布/变体条/历史条/会话结果图）—— prd_agent
   * updateSelectionWithChips + syncChipsToSelection 的语义移植：
   *  - 默认 replace：先清掉**其它**灰待选 chip（已确认的实体 chip 不动），
   *    这张图不在输入框则插入灰待选（光标处，无光标则追加）；
   *  - additive（Shift/Ctrl/Cmd 点选）：不清旧，仅补插；
   *  - 该图已是实体 chip → no-op（去重；移除走 chip 上的 ×）。
   *  确认（灰→实体）只发生在：点输入区 / 发送（confirmPending）。
   */
  const pickImage = useCallback(
    (ref: ChatInsertRefInput, opts?: { additive?: boolean }) => {
      const el = composerRef.current;
      if (!el) return;
      if (!opts?.additive) {
        el.querySelectorAll<HTMLElement>(
          '[data-chat-chip][data-ready="0"]',
        ).forEach((c) => {
          if (c.dataset.id !== ref.id) c.remove();
        });
      }
      // 同一张图允许多次引用（每个位置独立 chip，对齐 Lovart 文本 token 模型）；
      // 仅当已有同图「灰待选」时不重复插（防连点堆叠——确认后再点才是新引用）。
      const pendingSame = el.querySelector<HTMLElement>(
        `[data-chat-chip][data-id="${ref.id}"][data-ready="0"]`,
      );
      if (pendingSame) {
        syncComposerState();
        return;
      }
      if (
        el.querySelectorAll("[data-chat-chip]").length >= MAX_CHAT_IMAGE_INPUTS
      ) {
        setErr(`最多引用 ${MAX_CHAT_IMAGE_INPUTS} 张图片`);
        return;
      }
      setErr(null);
      const chip = buildChipElement(ref);
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
      syncComposerState();
    },
    [syncComposerState],
  );

  // 页面桥：画布/变体条/历史条点选与空白清除 → composer 操控 API。
  useEffect(() => {
    if (!insertRef) return;
    insertRef.current = { pick: pickImage, clearPending, confirmPending };
    return () => {
      insertRef.current = null;
    };
  }, [insertRef, pickImage, clearPending, confirmPending]);

  /* ---------- 序列化 / 发送 ---------- */

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
              kind: child.dataset.kind === "ASSET" ? "ASSET" : "VERSION",
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
        if (topLevel && tokens.length > 0) tokens.push({ type: "text", text: "\n" });
        walk(child, false);
      });
    };
    walk(root, true);
    return tokens;
  }

  /** 返回是否提交成功——失败时调用方保留输入框内容让用户改后重试（Codex P2）。 */
  async function submit(payload: {
    displayText: string;
    imageInputs: ChatComposerRef[];
  }): Promise<boolean> {
    if (sendingRef.current) return false;
    if (!projectId) {
      setErr("请先选择项目");
      return false;
    }
    const size = SIZE_OPTIONS[sizeIdx] ?? SIZE_OPTIONS[0];
    sendingRef.current = true;
    setSending(true);
    setErr(null);
    try {
      const res = await apiFetch<{
        generation: { id: string };
        jobId: string | null;
      }>(`/api/workspaces/${wsId}/generations`, {
        method: "POST",
        body: JSON.stringify({
          projectId,
          sceneType,
          sellingPoint: buildModelBrief(payload.displayText).trim(),
          versionCount: 1,
          // 尺寸 chip → 单 target（1K 档，比例即用户所选）。
          targets: [
            {
              key: `chat-1k-${size.ratio.replace(":", "x")}`,
              label: `1K·${size.ratio}`,
              width: size.width,
              height: size.height,
            },
          ],
          ...(payload.imageInputs.length > 0
            ? {
                imageInputs: payload.imageInputs.map((r) => ({
                  kind: r.kind,
                  id: r.id,
                })),
              }
            : {}),
          // Campaign 配置的水印/logo 与旧表单提交同口径透传（Codex P2）：
          // direct prompt 只改提示词组装，水印是安全底线之一、照叠。
          ...(watermarkOverlays && watermarkOverlays.length > 0
            ? { watermarkOverlays }
            : {}),
          chatDisplayText: payload.displayText,
        }),
      });
      // 新出图立即成为当前选中——画布直接开始轮询渲染，不必等用户点「查看」
      // （父级只在 genId 为空时才从 history 播种，Codex P2）。
      if (res?.generation?.id) {
        onSubmitted?.(res.generation.id, res.jobId ?? null);
      }
      await qc.invalidateQueries({
        queryKey: ["brandai-project-gens", wsId, projectId],
      });
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "发送失败");
      // 失败也刷新会话流（Codex P2）：硬禁令路径服务端已落一条 FAILED 行
      // （带 chatContext）再回 422——不失效查询的话，被拦下的消息气泡与
      // 重试入口要等手动刷新才可见。非落库失败（配额/网络）多刷一次无害。
      void qc.invalidateQueries({
        queryKey: ["brandai-project-gens", wsId, projectId],
      });
      return false;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function send() {
    const el = composerRef.current;
    if (!el) return;
    // 发送前自动确认所有待选（TwoPhase handleSubmit 的移植）。
    confirmPending();
    const { displayText, imageInputs } = serializeComposerTokens(domToTokens(el));
    if (displayText.trim() === "" && imageInputs.length === 0) return;
    const ok = await submit({ displayText, imageInputs });
    // 失败（配额/引用失效/网络抖动）保留提示词与 chip，让用户修改后重试。
    if (!ok) return;
    el.innerHTML = "";
    syncComposerState();
  }

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

  const size = SIZE_OPTIONS[sizeIdx] ?? SIZE_OPTIONS[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 头部 */}
      <div className="shrink-0 pb-2">
        <div className="text-sm font-semibold text-foreground">
          Hi，我是你的 AI 设计师
        </div>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          点选画布/变体/历史图片即可插入引用（先灰色待选，再点一次或点输入区变
          实体色确认，第三次点取消）；直接输入文字即文生图。
        </p>
      </div>

      {/* 会话流（仅对话来源） */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto pr-1"
        style={{ overscrollBehavior: "contain" }}
      >
        {thread.length === 0 ? (
          <div className="mt-8 rounded-2xl border border-dashed border-border bg-background p-4 text-center text-xs leading-relaxed text-muted-foreground">
            还没有对话。
            <br />
            输入设计需求，或点选图片开始图生图。
          </div>
        ) : (
          <div className="flex flex-col gap-4 pb-2">
            {thread.map((g) => {
              const ctx = (g.chatContext ?? null) as ChatContextShape | null;
              const displayText = ctx?.displayText ?? "";
              const chips = (ctx?.imageInputs ?? []).map((c) => ({
                kind: c.kind,
                id: c.id,
                url: c.url,
              }));
              const active = g.status === "PENDING" || g.status === "RUNNING";
              const elapsedS = Math.max(
                0,
                Math.round((now - new Date(g.createdAt).getTime()) / 1000),
              );
              return (
                <div key={g.id} className="flex flex-col gap-2">
                  <div className="ml-6 self-end rounded-2xl rounded-br-md bg-accent-soft px-3 py-2">
                    <UserBubbleContent
                      displayText={displayText}
                      imageInputs={chips}
                    />
                    <div className="mt-1 text-right text-[10px] text-muted-foreground">
                      {fmtTime(g.createdAt)}
                    </div>
                  </div>
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
                            <div
                              key={v.id}
                              className="group relative w-[220px] overflow-hidden rounded-2xl rounded-bl-md border border-border transition-colors hover:border-primary"
                            >
                              {/* 点结果图 = 点选引用（与画布点选同语义：replace，Shift 累加） */}
                              <button
                                type="button"
                                title="点击引用此图（点输入区确认）"
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={(e) =>
                                  pickImage(
                                    {
                                      kind: "VERSION",
                                      id: v.id,
                                      url: v.imageUrl,
                                      label: labelFromGeneration(g),
                                    },
                                    {
                                      additive:
                                        e.shiftKey || e.metaKey || e.ctrlKey,
                                    },
                                  )
                                }
                                className="block w-full"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={v.imageUrl}
                                  alt="生成结果"
                                  className="w-full object-cover"
                                />
                              </button>
                              <span className="absolute bottom-1 left-1 rounded-full bg-card/90 px-1.5 py-0.5 text-[10px] text-foreground">
                                {v.width}×{v.height}
                                {chips.length > 0 ? ` · 图生图×${chips.length}` : ""}
                              </span>
                              <button
                                type="button"
                                title="在画布中查看"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onViewGeneration(g.id);
                                }}
                                className="absolute right-1 top-1 rounded-full bg-card/90 px-1.5 py-0.5 text-[10px] text-primary opacity-0 transition-opacity group-hover:opacity-100"
                              >
                                查看
                              </button>
                            </div>
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

      {/* 输入面板（物理移植：surface-inset 容器 + 待确认徽标 + 底栏） */}
      <div className="relative mt-2 shrink-0 pb-12">
        {pendingCount > 0 ? (
          <div className="absolute -top-3 right-1 z-10 flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[10px] text-muted-foreground shadow-sm">
            <span>
              待确认 <span className="font-semibold text-foreground">{pendingCount}</span> 张
            </span>
            <button
              type="button"
              onClick={clearPending}
              className="text-primary underline"
            >
              清除
            </button>
          </div>
        ) : null}

        <div
          className="rounded-[12px] border border-border bg-background p-2 shadow-[inset_0_1px_3px_rgba(0,0,0,0.06)] focus-within:border-primary/40"
          style={{ cursor: "text" }}
          onClick={(e) => {
            // 点击输入区任意处 = 确认待选（TwoPhase handleContainerClick）。
            const t = e.target as HTMLElement;
            if (t.closest("[data-chip-remove]")) {
              t.closest("[data-chat-chip]")?.remove();
              syncComposerState();
              return;
            }
            confirmPending();
          }}
        >
          <div className="relative">
            {composerEmpty && pendingCount === 0 ? (
              <span className="pointer-events-none absolute left-0 top-0 select-none text-[14px] leading-5 text-muted-foreground">
                请输入你的设计需求（Enter 发送，Shift+Enter 换行）
              </span>
            ) : null}
            {pendingCount > 0 && composerEmpty ? (
              <span className="pointer-events-none absolute left-0 top-6 select-none text-[12px] leading-5 text-muted-foreground">
                点击此处确认选择，或继续输入...
              </span>
            ) : null}
            <div
              ref={composerRef}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              aria-label="设计需求输入（点选图片插入引用）"
              data-testid="chat-composer"
              className="w-full overflow-y-auto outline-none"
              style={{
                minHeight: 96,
                maxHeight: 132,
                fontSize: 14,
                lineHeight: "20px",
              }}
              onInput={syncComposerState}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              onPaste={(e) => {
                e.preventDefault();
                // 图片粘贴 → 上传进画布（prd_agent RC onPaste → onUploadImages 同款）。
                const imgs = Array.from(e.clipboardData.files).filter((f) =>
                  f.type.startsWith("image/"),
                );
                if (imgs.length > 0 && onPasteImage) {
                  onPasteImage(imgs);
                  return;
                }
                const text = e.clipboardData.getData("text/plain");
                // V0.0.13f — chip 文本 token 粘贴还原（[@image:#N:KIND_id:url]）：
                // 复制过的提示词（含图片引用）粘回来即恢复 chips；外部 token 保持纯文本。
                const segs = parseChipTokenText(text);
                if (segs.some((sg) => sg.type === "chip")) {
                  const el = composerRef.current;
                  const sel = window.getSelection();
                  if (!el || !sel || sel.rangeCount === 0) return;
                  const range = sel.getRangeAt(0);
                  if (!el.contains(range.commonAncestorContainer)) return;
                  range.deleteContents();
                  const frag = document.createDocumentFragment();
                  let inserted = 0;
                  const already =
                    el.querySelectorAll("[data-chat-chip]").length;
                  for (const sg of segs) {
                    if (sg.type === "text") {
                      frag.appendChild(document.createTextNode(sg.text));
                      continue;
                    }
                    if (already + inserted >= MAX_CHAT_IMAGE_INPUTS) continue;
                    const chip = buildChipElement({
                      kind: sg.ref.kind,
                      id: sg.ref.id,
                      url: sg.ref.url,
                      label: "引用图",
                    });
                    // 粘贴还原的引用是成品内容 → 直接实体态（无需再两阶段确认）。
                    applyChipReadyStyle(chip, true);
                    frag.appendChild(chip);
                    inserted += 1;
                  }
                  range.insertNode(frag);
                  sel.collapseToEnd();
                  syncComposerState();
                  return;
                }
                document.execCommand("insertText", false, text);
                syncComposerState();
              }}
              onCopy={(e) => {
                const out = selectionToTokenText();
                if (out != null) {
                  e.preventDefault();
                  e.clipboardData.setData("text/plain", out);
                }
              }}
              onCut={(e) => {
                const out = selectionToTokenText();
                if (out != null) {
                  e.preventDefault();
                  e.clipboardData.setData("text/plain", out);
                  const sel = window.getSelection();
                  if (sel && sel.rangeCount > 0) sel.getRangeAt(0).deleteContents();
                  syncComposerState();
                }
              }}
            />
          </div>
        </div>

        {/* 底栏：左 尺寸chip · 右 模型chip + 圆形发送 */}
        <div className="mt-1 flex items-center justify-between gap-1.5">
          <div className="relative">
            <button
              type="button"
              onClick={() => setSizeOpen((v) => !v)}
              className={[
                "h-7 rounded-full px-2.5 text-[11px] font-semibold transition-colors",
                sizeOpen
                  ? "bg-accent-soft text-primary"
                  : "border border-border bg-card text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              1K · {size.ratio} <span aria-hidden>▾</span>
            </button>
            {sizeOpen ? (
              <div className="absolute bottom-9 left-0 z-20 w-[220px] rounded-2xl border border-border bg-card p-3 shadow-lg">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  分辨率
                </div>
                <div className="mb-2 flex gap-1.5">
                  <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold text-primary">
                    1K
                  </span>
                </div>
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Size
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {SIZE_OPTIONS.map((o, i) => {
                    const activeOpt = i === sizeIdx;
                    const rw = o.width;
                    const rh = o.height;
                    const w = rw >= rh ? 22 : Math.round((22 * rw) / rh);
                    const h = rh >= rw ? 22 : Math.round((22 * rh) / rw);
                    return (
                      <button
                        key={o.ratio}
                        type="button"
                        onClick={() => {
                          setSizeIdx(i);
                          setSizeOpen(false);
                        }}
                        className={[
                          "flex flex-col items-center gap-1 rounded-xl border px-2 py-1.5 text-[10px] transition-colors",
                          activeOpt
                            ? "border-primary/60 bg-accent-soft text-primary"
                            : "border-border text-muted-foreground hover:border-primary/30",
                        ].join(" ")}
                      >
                        <span
                          className={[
                            "rounded-[3px] border",
                            activeOpt ? "border-primary" : "border-muted-foreground/50",
                          ].join(" ")}
                          style={{ width: w, height: h }}
                        />
                        {o.ratio}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-1.5">
            <span
              title="平台配置的生图模型（/admin/settings/ai 可改）"
              className="inline-flex h-7 max-w-[140px] items-center gap-1 truncate rounded-full bg-accent-soft px-2.5 text-[11px] font-medium text-primary"
            >
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full bg-primary"
              />
              gpt-image-2
            </span>
            <button
              type="button"
              onClick={() => void send()}
              disabled={sending || (composerEmpty && chipCount === 0)}
              title="发送（Enter）"
              aria-label="发送"
              className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity disabled:opacity-50"
            >
              {sending ? (
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
              ) : (
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
        {err ? <p className="mt-1.5 text-[11px] text-destructive">{err}</p> : null}
      </div>
    </div>
  );
}

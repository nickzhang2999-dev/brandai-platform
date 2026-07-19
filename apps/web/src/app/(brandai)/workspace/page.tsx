"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Asset,
  Generation,
  GenerationVersion,
  ListMembersResponse,
  Project,
  ProjectAssetLink,
  SizeSpec,
  WatermarkOverlayInput,
  WorkspaceRole,
  GenerationDefaultSource,
  AssetInvocationMode,
} from "@brandai/contracts";
import { CHANNEL_SIZES, resolveGenerationDefaults } from "@brandai/contracts";
import { apiFetch, assetThumbUrl } from "@/lib/client";
import { planTiers, upgradeContactEmail } from "@/lib/brandai-mock";
import { validateImageUploadFile } from "@/lib/upload-limits";
import {
  addReference,
  getReferences,
  removeReference,
  subscribeReferences,
  type RefAsset,
} from "@/lib/reference-tray";
import { useBrand } from "../brand-context";
import { MaskPaintCanvas } from "./MaskPaintCanvas";
import { OpenCanvas } from "./OpenCanvas";
import { ChatPanel, type ChatComposerApi } from "./ChatPanel";

/**
 * P05 · AI 工作台 — 左画布 + 变体条，右 prompt 面板。真实出图（CLAUDE.md §2，
 * server-authoritative）：提交 → POST /generations(202, 落 PENDING + 入队) →
 * 客户端轮询 GET /generations/[id]?jobId= → worker→apps/ai→真 provider 出图 →
 * GenerationVersion.imageUrl 浮现。客户端中间态有界，超时给出口。
 */
const SCENE_TYPES: { value: string; label: string }[] = [
  { value: "SOCIAL_POSTER", label: "社交海报" },
  { value: "ECOM_MAIN", label: "电商主图" },
  { value: "SCENE", label: "场景图" },
  { value: "CAMPAIGN_KV", label: "Campaign KV" },
  { value: "SELLING_POINT", label: "卖点图" },
];

// 迁移自 prd_agent 视觉创作 —— 选中图片上方的浮动操作工具条。「局部重画」是特殊项
// （打开蒙版绘制覆盖层 → op=INPAINT + mask），其余项选中后用快捷编辑框补指令即出图。
// 全部走真实 server-authoritative 改图链路（/edit → worker → ai.edit → 真 provider）。
const CANVAS_OPS: { value: string; label: string; mask?: boolean }[] = [
  { value: "INPAINT", label: "局部重画", mask: true },
  { value: "IMAGE_EDIT", label: "整图修改" },
  { value: "OUTPAINT", label: "扩展" },
  { value: "REPLACE_BACKGROUND", label: "换背景" },
  { value: "RECOLOR", label: "改色" },
  { value: "EDIT_TEXT", label: "改文字" },
  { value: "ADD_ELEMENT", label: "加元素" },
  { value: "REMOVE_ELEMENT", label: "去元素" },
];

const POLL_CAP_MS = 6 * 60 * 1000; // §2.2 有界中间态

type WorkspaceMode = "TEXT_TO_IMAGE" | "IMAGE_EDIT" | "INPAINT" | "OUTPAINT";
type OutpaintDirection = "left" | "right" | "top" | "bottom" | "all";
const WORKSPACE_MODES: {
  value: WorkspaceMode;
  label: string;
  hint: string;
}[] = [
  {
    value: "TEXT_TO_IMAGE",
    label: "文字生图",
    hint: "从项目、品牌套件与文字描述生成新图。",
  },
  {
    value: "IMAGE_EDIT",
    label: "整图修改",
    hint: "基于当前/历史图继续迭代，不重新开始。",
  },
  {
    value: "INPAINT",
    label: "局部修改",
    hint: "框选或涂抹局部区域，只改选区。",
  },
  {
    value: "OUTPAINT",
    label: "扩图",
    hint: "向指定方向延展画布并自然补全。",
  },
];

const OUTPAINT_DIRECTIONS: {
  value: OutpaintDirection;
  label: string;
  hint: string;
}[] = [
  { value: "right", label: "向右", hint: "增加右侧留白或延展场景" },
  { value: "left", label: "向左", hint: "扩展左侧画面" },
  { value: "top", label: "向上", hint: "增加天空、背景或上方空间" },
  { value: "bottom", label: "向下", hint: "延展地面、产品台面或下方信息区" },
  { value: "all", label: "四周", hint: "按比例扩展整张画布" },
];

const INVOCATION_MODES: {
  value: AssetInvocationMode;
  label: string;
  hint: string;
}[] = [
  {
    value: "REFERENCE",
    label: "只参考",
    hint: "不保证进入最终画面，只参考风格、色系、构图。",
  },
  {
    value: "EXACT",
    label: "绝对调用",
    hint: "素材内容不被 AI 修改，可手动调整位置和显示尺寸。",
  },
  {
    value: "ADAPTIVE",
    label: "适配调用",
    hint: "必须出现，可锁比例缩放，可按品牌色系调整。",
  },
];
const WATERMARK_INVOCATION_MODES = INVOCATION_MODES.filter(
  (mode) => mode.value !== "REFERENCE",
);

// 版本的“真实像素尺寸”。OpenAI 会把请求画布 snap 到最近的支持档(如 1920×1080 →
// 1536×1024)，generate.worker 把 snap 后的真实字节尺寸落进 params.actualWidth/Height
// (见 generate.worker.ts K5)。局部重画蒙版必须按真实字节尺寸绘制/导出——否则蒙版在
// object-contain 的 <img> 里被拉伸/偏移，_build_inpaint_mask 再 resize 到真实字节时
// 涂抹区错位、provider 改错地方(Codex P2)。缺 actual 时回退请求 width/height。
function versionPixelSize(v: GenerationVersion): {
  width: number;
  height: number;
} {
  const p = (v.params ?? {}) as Record<string, unknown>;
  const aw = typeof p.actualWidth === "number" ? p.actualWidth : null;
  const ah = typeof p.actualHeight === "number" ? p.actualHeight : null;
  return {
    width: aw && ah ? aw : v.width || 1024,
    height: aw && ah ? ah : v.height || 1024,
  };
}

type JobState = {
  generation: Generation;
  job: {
    jobId: string;
    status: string;
    progress: number;
    failedReason?: string;
  };
};

// F11 — read-only quota status (GET /api/workspaces/[wsId]/quota). -1 = 不限.
type QuotaStatus = {
  dailyUsed: number;
  dailyLimit: number;
  periodUsed: number;
  monthlyQuota: number;
  plan: string;
};

// F7 — UI suggestion chips (text content only; not colors).
const SUGGESTED_KEYWORDS = ["简约", "高级感", "科技感", "暖色调", "自然光"];
const MAX_KEYWORDS = 20;

type WatermarkPreset = {
  id: string;
  workspaceId: string;
  name: string;
  isActive: boolean;
  config: WatermarkOverlayInput;
  createdAt: string;
  updatedAt: string;
};

function defaultWatermarkOverlay(assetId?: string): WatermarkOverlayInput {
  return {
    ...(assetId ? { assetId } : {}),
    invocationMode: "EXACT",
    lockAspectRatio: true,
    allowRecolor: false,
    enabled: true,
    anchor: "bottom-right",
    positionMode: "pixel",
    offsetX: 24,
    offsetY: 24,
    widthPx: 120,
    fontFamily: "Inter",
    fontSizePx: 28,
    opacity: 0.85,
    textColor: "#111827",
    backgroundEnabled: false,
    backgroundColor: "#FFFFFF",
    borderEnabled: false,
    borderColor: "#7C5CFF",
    borderWidth: 1,
    cornerRadius: 0,
  };
}

// G1 — parse a template `?style=a,b,c` param into a deduped, capped keyword list.
function parseStyleParam(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const kw = part.trim();
    if (kw && !out.includes(kw) && out.length < MAX_KEYWORDS) out.push(kw);
  }
  return out;
}

export default function WorkspacePage() {
  return (
    <Suspense
      fallback={
        <div className="p-10 text-sm text-muted-foreground">加载中…</div>
      }
    >
      <Workspace />
    </Suspense>
  );
}

function Workspace() {
  const { wsId, brandName, brands } = useBrand();
  const search = useSearchParams();
  const pathname = usePathname();
  const presetProject = search.get("project");
  // E · 深链/刷新恢复 —— ?gen= 指明当前查看的出图。通知中心与队列 widget 都跳到
  // /workspace?gen=<id>&project=<pid>;刷新也带着它,落到精确那张而非空白/最近。
  const presetGen = search.get("gen");
  // B2 · 首页 brief 透传 — 把首页输入的描述作为出图卖点初始值（仅首屏播种，
  // 不在每次渲染时覆盖用户后续编辑）。
  const presetBrief = search.get("brief");
  // G1 · 模板库带入 — 模板把场景 / 画面类型 / 风格关键词经 query 预填（同 brief
  // 透传：仅在 URL 参数变化的真实导航时播种，不覆盖用户后续手动编辑）。
  const presetScene = search.get("scene");
  const presetSceneType = search.get("sceneType");
  const presetStyle = search.get("style");

  const { data: projects = [] } = useQuery({
    queryKey: ["brandai-projects", wsId],
    queryFn: () => apiFetch<Project[]>(`/api/workspaces/${wsId}/projects`),
  });

  const [projectId, setProjectId] = useState<string | null>(presetProject);
  // React to client-side navigations that change `?project=` (E11/E12 「加入项目」
  // and the homepage brief flow router.push to /workspace?project=… without a
  // remount). Without this the prior project stays selected and reference-tray
  // assets + POST /generations would target the wrong project.
  useEffect(() => {
    if (presetProject) setProjectId(presetProject);
  }, [presetProject]);
  useEffect(() => {
    if (!projectId && projects.length > 0) setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  const [sellingPoint, setSellingPoint] = useState(
    presetBrief?.trim() ? presetBrief.trim().slice(0, 500) : "",
  );
  // F2 / L6 — undo/redo for the generation-form state. We track a snapshot of
  // every editable field in a bounded history stack and expose undo/redo that
  // restores a whole snapshot. `applyingHistory` suppresses re-recording while
  // a restore is in flight (so undo→redo round-trips cleanly).
  const applyingHistory = useRef(false);
  // Re-seed 卖点 when a NEW brief arrives via client navigation (the URL param
  // changes). This only fires on a real navigation — typing in the textarea
  // doesn't change `presetBrief`, so manual edits are never clobbered.
  useEffect(() => {
    if (presetBrief?.trim()) setSellingPoint(presetBrief.trim().slice(0, 500));
  }, [presetBrief]);
  const [scene, setScene] = useState(presetScene?.trim() || "");
  // Only honor a sceneType the workspace actually offers (avoid a dangling value
  // from a hand-edited URL); otherwise fall back to the default.
  const SCENE_TYPE_VALUES = SCENE_TYPES.map((s) => s.value);
  const [sceneType, setSceneType] = useState(
    presetSceneType && SCENE_TYPE_VALUES.includes(presetSceneType)
      ? presetSceneType
      : "SOCIAL_POSTER",
  );
  const [versionCount, setVersionCount] = useState(4);
  const activeProject = useMemo(
    () => projects.find((p) => p.id === projectId) ?? projects[0] ?? null,
    [projectId, projects],
  );
  const activeBrand = useMemo(
    () => brands.find((brand) => brand.id === wsId) ?? { name: brandName },
    [brandName, brands, wsId],
  );
  const [workspaceMode, setWorkspaceMode] =
    useState<WorkspaceMode>("TEXT_TO_IMAGE");
  // V0.0.13c/d — 视觉创作交互物理移植：点选 画布/变体条/历史条 图片 → 灰待选
  // chip（replace；Shift/Ctrl 累加）；点输入区/发送确认；点画布空白清待选。
  const chatInsertRef = useRef<ChatComposerApi | null>(null);
  // composer 粘贴图片 → 画布上传入口（OpenCanvas 注入）。
  const chatUploadFilesRef = useRef<((files: File[]) => void) | null>(null);
  // 输入框内当前引用（有序 + 就绪态），驱动源图的 灰罩✓ / violet 描边 + 序号。
  const [chatComposerRefs, setChatComposerRefs] = useState<
    { id: string; ready: boolean }[]
  >([]);
  /** 点选一张源图（prd_agent replace/additive 语义）。 */
  const chatPickImage = useCallback(
    (
      ref: { kind?: "VERSION" | "ASSET"; id: string; url: string; label?: string },
      opts?: { additive?: boolean },
    ) => {
      chatInsertRef.current?.pick(
        { kind: ref.kind ?? "VERSION", id: ref.id, url: ref.url, label: ref.label },
        opts,
      );
    },
    [],
  );
  /** 源图当前在输入框中的状态（无 / 待选灰 / 就绪）+ 序号。 */
  const chatRefState = useCallback(
    (id: string): { ordinal: number; ready: boolean } | null => {
      const idx = chatComposerRefs.findIndex((r) => r.id === id);
      if (idx < 0) return null;
      return { ordinal: idx + 1, ready: chatComposerRefs[idx]!.ready };
    },
    [chatComposerRefs],
  );
  /** OpenCanvas 消费的 id→引用态映射（versionId/assetId 通用）。 */
  const chatRefStatesMap = useMemo(() => {
    const m: Record<string, { ordinal: number; ready: boolean }> = {};
    chatComposerRefs.forEach((r, i) => {
      if (r.id) m[r.id] = { ordinal: i + 1, ready: r.ready };
    });
    return m;
  }, [chatComposerRefs]);
  const [editBaseVersionId, setEditBaseVersionId] = useState<string | null>(
    null,
  );
  const [outpaintDirection, setOutpaintDirection] =
    useState<OutpaintDirection>("right");
  const [outpaintScale, setOutpaintScale] = useState(35);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
  const resolvedGenerationBrief = useMemo(
    () =>
      resolveGenerationDefaults({
        project: activeProject,
        brand: activeBrand,
        sceneType,
        sellingPoint,
        scene,
      }),
    [activeProject, activeBrand, sceneType, sellingPoint, scene],
  );

  // K5 · P2.0 多尺寸 — 选中的渠道尺寸档位（按 CHANNEL_SIZES.key 跟踪）。≥1 个时
  // POST body 带 targets（每尺寸各出 1 张，AI 服务忽略 versionCount）。
  const [targetKeys, setTargetKeys] = useState<string[]>([]);
  const selectedTargets: SizeSpec[] = useMemo(
    () => CHANNEL_SIZES.filter((s) => targetKeys.includes(s.key)),
    [targetKeys],
  );
  const multiSize = selectedTargets.length > 0;
  function toggleTarget(key: string) {
    setTargetKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  // K5 · M3 文本策略 — direct（默认，模型可烤字）/ layered（留干净负空间、不烤字）。
  const [textMode, setTextMode] = useState<"direct" | "layered">("direct");

  // F7 · 风格关键词 (max 20) — threaded into POST /generations as styleKeywords.
  // G1 — seed from a template's `?style=a,b,c` on first render (deduped, capped).
  const [styleKeywords, setStyleKeywords] = useState<string[]>(() =>
    parseStyleParam(presetStyle),
  );
  const [keywordDraft, setKeywordDraft] = useState("");

  function addKeyword(raw: string) {
    const kw = raw.trim();
    if (!kw) return;
    setStyleKeywords((prev) =>
      prev.includes(kw) || prev.length >= MAX_KEYWORDS ? prev : [...prev, kw],
    );
  }
  function removeKeyword(kw: string) {
    setStyleKeywords((prev) => prev.filter((k) => k !== kw));
  }
  function onKeywordKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKeyword(keywordDraft);
      setKeywordDraft("");
    } else if (e.key === "Backspace" && !keywordDraft && styleKeywords.length) {
      removeKeyword(styleKeywords[styleKeywords.length - 1]!);
    }
  }

  // G1 — re-seed scene / sceneType / styleKeywords on a fresh template navigation
  // (the URL params change). Only fires on a real navigation, so manual edits are
  // never clobbered (typing in the fields doesn't change these params).
  useEffect(() => {
    if (presetScene?.trim()) setScene(presetScene.trim());
  }, [presetScene]);
  useEffect(() => {
    if (presetSceneType && SCENE_TYPE_VALUES.includes(presetSceneType))
      setSceneType(presetSceneType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetSceneType]);
  useEffect(() => {
    const kws = parseStyleParam(presetStyle);
    if (kws.length) setStyleKeywords(kws);
  }, [presetStyle]);

  // V0.0.9 · 素材（水印使用）— localStorage-backed, scoped to (wsId, projectId),
  // shared with the assets page. These assets are NOT sent to AI as references;
  // worker composites them deterministically after base generation.
  const [references, setReferences] = useState<RefAsset[]>([]);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [templateReferences, setTemplateReferences] = useState<RefAsset[]>([]);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [watermarkEditorOpen, setWatermarkEditorOpen] = useState(false);
  const [watermarkOverlays, setWatermarkOverlays] = useState<
    WatermarkOverlayInput[]
  >([]);
  const activeWatermarkOverlays = useMemo(
    () =>
      watermarkOverlays.filter(
        (overlay) =>
          overlay.enabled !== false &&
          (overlay.invocationMode ?? "EXACT") !== "REFERENCE",
      ),
    [watermarkOverlays],
  );
  useEffect(() => {
    if (!projectId) {
      setReferences([]);
      setTemplateReferences([]);
      return;
    }
    let cancelled = false;
    // E11/E12 — merge the durable server-side REFERENCE links (source of truth,
    // survives across devices) with the local tray (instant same-tab feedback),
    // de-duped by asset id. A server miss degrades gracefully to tray-only.
    const refresh = () => {
      const tray = getReferences(wsId, projectId);
      setReferences(tray);
      apiFetch<ProjectAssetLink[]>(
        `/api/workspaces/${wsId}/projects/${projectId}/assets?kind=REFERENCE`,
      )
        .then((links) => {
          if (cancelled) return;
          const seen = new Set(tray.map((r) => r.id));
          const fromServer: RefAsset[] = links
            .filter(
              (l) =>
                !seen.has(l.asset.id) &&
                (l.asset.libraryKind ?? "MATERIAL") === "MATERIAL",
            )
            .map((l) => ({
              id: l.asset.id,
              fileName: l.asset.fileName,
              thumbUrl: assetThumbUrl(wsId, l.asset.id, l.asset.url),
            }));
          if (fromServer.length > 0) {
            setReferences((prev) => [...prev, ...fromServer]);
          }
        })
        .catch(() => {
          /* tray-only fallback */
        });
    };
    refresh();
    const unsub = subscribeReferences(refresh);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [wsId, projectId]);
  useEffect(() => {
    setWatermarkOverlays((prev) => {
      const byAsset = new Map(
        prev.filter((o) => o.assetId).map((o) => [o.assetId!, o]),
      );
      return references.map(
        (r) => byAsset.get(r.id) ?? defaultWatermarkOverlay(r.id),
      );
    });
  }, [references]);
  function dropReference(assetId: string) {
    if (!projectId) return;
    removeReference(wsId, projectId, assetId);
    setReferences((prev) => prev.filter((r) => r.id !== assetId));
    // E11/E12 — also drop the durable server link (best-effort).
    apiFetch(`/api/workspaces/${wsId}/projects/${projectId}/assets`, {
      method: "DELETE",
      body: JSON.stringify({ assetId, kind: "REFERENCE" }),
    }).catch(() => {});
  }
  function addPickedReferences(items: RefAsset[]) {
    if (!projectId) return;
    const next = [...references];
    for (const item of items) {
      if (next.some((r) => r.id === item.id)) continue;
      if (next.length >= 8) break;
      next.push(item);
      addReference(wsId, projectId, item);
      apiFetch(`/api/workspaces/${wsId}/projects/${projectId}/assets`, {
        method: "POST",
        body: JSON.stringify({ assetId: item.id, kind: "REFERENCE" }),
      }).catch(() => {});
    }
    setReferences(next);
  }
  function addTemplateReferences(items: RefAsset[]) {
    const next = [...templateReferences];
    for (const item of items) {
      if (next.some((r) => r.id === item.id)) continue;
      if (next.length >= 8) break;
      next.push(item);
    }
    setTemplateReferences(next);
  }
  function dropTemplateReference(assetId: string) {
    setTemplateReferences((prev) => prev.filter((r) => r.id !== assetId));
  }

  // F11 · 生成额度展示 — read-only quota status.
  const { data: quota } = useQuery<QuotaStatus>({
    queryKey: ["brandai-quota", wsId],
    queryFn: () => apiFetch<QuotaStatus>(`/api/workspaces/${wsId}/quota`),
    enabled: !!wsId,
  });

  // 历史出图回看 — 进入工作台默认能看到本 Campaign 已生成的图，而不是空态。
  // 接现成的 GET /generations?projectId=（listProjectGenerations，newest first）。
  // 修复「产出蒸发」：刷新/切项目/换设备后历史出图不再消失。
  const { data: history = [] } = useQuery<Generation[]>({
    queryKey: ["brandai-project-gens", wsId, projectId],
    queryFn: () =>
      apiFetch<Generation[]>(
        `/api/workspaces/${wsId}/generations?projectId=${projectId}`,
      ),
    enabled: !!wsId && !!projectId,
  });

  // H9 · 提交制作确认弹窗 — 提交前先汇总将要生成的内容（场景/卖点/数量/尺寸/风格）
  // + 额度提示，确认后再走真实 POST /generations 出图流。
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  // H12 · 额度升级弹窗（信息性，无真实计费）。
  const [showUpgrade, setShowUpgrade] = useState(false);

  const [genId, setGenId] = useState<string | null>(presetGen);
  const [jobId, setJobId] = useState<string | null>(null);
  const [activeVariant, setActiveVariant] = useState(0);
  // 画布上是否正有一张「当前变体 tile」被选中。点画布空白清选后画布无版本选中,但
  // activeVariant/current 仍保留(终选/导出仍有目标)——用它让变体条高亮跟随画布选择,
  // 清选即熄灭高亮,不出现「条高亮而画布空」的割裂(Bugbot Medium)。
  const [canvasSel, setCanvasSel] = useState(true);
  // 点变体缩略图的显式信号:即便点的是「已是当前」的变体(activeVersionId 不变、同步
  // effect 不会重触发),也强制画布重新选中该 tile,消除「清选后点缩略图无反应」死锁。
  const [selectNonce, setSelectNonce] = useState(0);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const startedAt = useRef<number>(0);
  const [timedOut, setTimedOut] = useState(false);
  // 改图(edit)中间态计时 —— §2.4 有界:改图轮询超过上界给明确出口,绝不无限「改图中…」。
  const editStartedAt = useRef<number>(0);
  // 改图客户端超时后,worker 可能仍在后台完成 —— 记一个有界的「继续观察到」时刻,让
  // 主 generation 查询在此期间即便已 SUCCEEDED 也慢速续轮询,迟到的改图子版本才能
  // 自动浮现,不必整页刷新(Bugbot Medium)。
  const [editWatchUntil, setEditWatchUntil] = useState(0);

  const { data: poll } = useQuery<JobState>({
    queryKey: ["brandai-gen", wsId, genId, jobId],
    queryFn: () =>
      apiFetch<JobState>(
        // jobId 仅在「本次会话刚提交」时存在；回看历史出图（无 job）时省略，
        // 路由会回退到 generation.status（SUCCEEDED），不再拼出 ?jobId=null。
        `/api/workspaces/${wsId}/generations/${genId}${jobId ? `?jobId=${jobId}` : ""}`,
      ),
    enabled: !!genId,
    refetchInterval: (q) => {
      const d = q.state.data;
      const s = d?.job?.status ?? d?.generation.status;
      if (s === "SUCCEEDED" || s === "FAILED") {
        // 改图超时后的有界续观察:generation 虽已终态,仍慢速轮询以捞回迟到的改图子版本。
        return editWatchUntil > Date.now() ? 8000 : false;
      }
      // §2.4 6-min 上界。实时出图(有 jobId)用本地 startedAt;回看历史出图
      // (jobId=null → startedAt=0)改用该 generation 的服务端起始时间
      // (startedAt→createdAt),否则 0 会让仍在跑的历史出图被瞬间判超时而停轮询,
      // 卡死在"生成中"直到整页刷新(Bugbot #3d80902a)。无可解析时间则继续轮询。
      const startMs =
        startedAt.current > 0
          ? startedAt.current
          : Date.parse(
              d?.generation.startedAt ?? d?.generation.createdAt ?? "",
            ) || 0;
      if (startMs > 0 && Date.now() - startMs > POLL_CAP_MS) return false;
      return 2500;
    },
  });

  // 中间态超时只在「本会话实时出图」（有 jobId）时计时；回看历史出图（jobId=null）
  // 不参与计时，否则 startedAt=0 会被瞬间判超时。
  useEffect(() => {
    if (!genId || !jobId) return;
    const t = setInterval(() => {
      if (Date.now() - startedAt.current > POLL_CAP_MS) setTimedOut(true);
    }, 3000);
    return () => clearInterval(t);
  }, [genId, jobId]);

  // 切换 Campaign 时清掉当前查看的出图，交给下面的「默认展示最近一次」按新项目
  // 重新播种（否则上一个项目的图会残留、且 POST/改图会打到错项目）。
  const prevProjectRef = useRef<string | null>(projectId);
  useEffect(() => {
    if (prevProjectRef.current === projectId) return;
    prevProjectRef.current = projectId;
    // 切项目默认清空当前出图,交给 seed-latest 重新播种。例外:若这次切项目来自
    // URL 深链(presetProject 已等于新 projectId)且带了 ?gen=,尊重深链那张
    // (通知/队列点到的是「另一个 Campaign 的某次出图」时,别被清成最近一次)。
    const deep = presetProject === projectId && presetGen ? presetGen : null;
    setGenId(deep);
    setJobId(null);
    setTimedOut(false);
    setActiveVariant(0);
  }, [projectId, presetProject, presetGen]);

  // E · 客户端导航到 ?gen=(已在工作台时点通知/队列) → 切到那次出图。整页加载走
  // genId 初始值;这里只接 URL 变化(soft nav)。
  useEffect(() => {
    if (presetGen && presetGen !== genId) {
      setGenId(presetGen);
      setJobId(null);
      setTimedOut(false);
      setActiveVariant(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetGen]);

  // E · 反向同步:把当前 Campaign 写回 URL(?project=),让刷新/分享落到同一项目。
  // 用 ref 只在 projectId「真的变了」时写——手动切 <select>、默认选 projects[0]、
  // 「加入项目」程序化导航都覆盖(Codex: 默认/侧边栏/模板入口选中的项目也必须进
  // URL,否则出图成功后 ?gen= 反向同步会产出缺 project 的分享链,刷新/分享时把这
  // 次出图绑到当前最新的 campaign,project 作用域的历史/引用/导出全落错项目)。
  // 深链导航改 ?project= 时本 effect 因 search 变化触发,但此刻 projectId 尚未被
  // 上面的同步 effect 更新(ref===projectId)→直接跳过,不会用旧 projectId 把深链
  // 改回去(Bugbot: stale project in deep link)。
  const lastUrlProjectRef = useRef<string | null>(projectId);
  useEffect(() => {
    if (lastUrlProjectRef.current === projectId) return;
    const prev = lastUrlProjectRef.current;
    lastUrlProjectRef.current = projectId;
    if (!projectId) return;
    // 关键:从「实时地址栏」(window.location.search)读当前 query,而非 useSearchParams()。
    // 用 history.replaceState 做浅层 URL 同步(避免 router.replace 的 RSC 软导航环/抖动),
    // 但 Next 的 useSearchParams() 在 replaceState 后【不会】刷新——若仍从它读旧值,gen
    // 同步会把过时的 ?project= 又写回去,刷新/分享打开错误 Campaign(Bugbot High)。
    // window.location.search 始终反映上一次 replaceState 的真实结果,读它才不串味。
    const cur = new URLSearchParams(window.location.search);
    if (cur.get("project") === projectId) return;
    cur.set("project", projectId);
    // 只有「从一个已同步项目切到另一个」才抹旧 ?gen=(交给下面 gen 反向同步按新项目
    // 重写);首次播种(prev=null,如默认选 projects[0])不抹,避免清掉仅带 ?gen= 的深链。
    if (prev) cur.delete("gen");
    window.history.replaceState(null, "", `${pathname}?${cur.toString()}`);
  }, [projectId, pathname]);

  // E · 反向同步:把当前查看的出图写回 URL(?gen=),让刷新/分享落到精确那张。
  // 实时出图/改图进行中(jobId 仅会话内存在)不写,避免把一次性 job 深链出去。
  useEffect(() => {
    if (jobId) return;
    if (!genId) return;
    // 同上:读实时地址栏(而非 useSearchParams,后者在 replaceState 后不刷新),这样
    // 上面 project 同步刚写入的 ?project= 会被带上,不会用旧 project 覆盖(Bugbot High)。
    const cur = new URLSearchParams(window.location.search);
    if (cur.get("gen") === genId) return;
    cur.set("gen", genId);
    window.history.replaceState(null, "", `${pathname}?${cur.toString()}`);
  }, [genId, jobId, pathname]);

  // E · 浏览器前进/后退(popstate)→ 让 in-app 状态跟随地址栏。上面用 replaceState 做
  // 浅层 URL 同步,这些 URL 变更 Next 的路由/useSearchParams 并不知情;用户 back/forward
  // 到这些历史项时,地址栏是一套值、genId/projectId 仍停在上一次 in-app 选择 → 画布/变体/
  // 分享链三者不一致(Bugbot Medium)。这里监听 popstate,直接从实时地址栏重解析并应用,
  // 同步 prevProjectRef/lastUrlProjectRef 避免「切项目重置 genId」「project 反向同步」两个
  // effect 回头覆盖。
  useEffect(() => {
    const onPop = () => {
      const q = new URLSearchParams(window.location.search);
      const p = q.get("project");
      const g = q.get("gen");
      if (p) {
        lastUrlProjectRef.current = p; // 别让 project 反向同步 effect 再写
        prevProjectRef.current = p; // 别让「切项目重置 genId」effect 清掉下面的 gen
        setProjectId(p);
      }
      setJobId(null);
      setTimedOut(false);
      setActiveVariant(0);
      setGenId(g || null); // g 为空则回落到「展示最近一次」
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // 进入工作台默认展示该项目最近一次出图（history newest-first）。仅当本会话
  // 还没有选中/提交任何出图时播种 —— 不覆盖用户的实时提交，也不覆盖手动切换的历史。
  useEffect(() => {
    if (genId) return;
    if (history.length > 0) {
      setGenId(history[0]!.id);
      setJobId(null);
      setTimedOut(false);
      setActiveVariant(0);
    }
  }, [history, genId]);

  // 点击历史缩略图回看某次出图：复用整套机制（轮询无 jobId → 回退 SUCCEEDED，
  // 改图/终选/导出/审阅全部对该历史出图生效）。
  function viewGeneration(id: string) {
    if (id === genId) return;
    setGenId(id);
    setJobId(null);
    setTimedOut(false);
    setActiveVariant(0);
    setSubmitErr(null);
  }

  // 对话面板提交成功 → 新出图立即成为当前选中（带 jobId 走完整 job 轮询），
  // 画布无需用户手点「查看」即渲染新图（Codex P2）。
  function onChatSubmitted(id: string, job: string | null) {
    // 有 jobId 即实时出图：先起本地计时表——超时 effect 用 startedAt 判 6 分钟
    // 上界，不起表会以 0 为起点、约 3 秒就误判超时（Codex P2）。
    startedAt.current = Date.now();
    setGenId(id);
    setJobId(job);
    setTimedOut(false);
    setActiveVariant(0);
    setSubmitErr(null);
  }

  const status = poll?.job?.status ?? poll?.generation.status ?? null;
  const versions = useMemo(() => poll?.generation.versions ?? [], [poll]);
  const running =
    !!genId && status !== "SUCCEEDED" && status !== "FAILED" && !timedOut;
  const current = versions[activeVariant] ?? versions[0];
  const editBaseVersion =
    versions.find((v) => v.id === editBaseVersionId) ?? current ?? null;

  // popstate/缩略图切到「只有 ?gen= 没有 ?project=」或跨项目的历史出图时,加载出的
  // generation 自带 projectId → 让 projectId 跟随,否则 campaign 作用域/历史/参考区
  // 停在旧 project 与正在看的出图错位(Bugbot Medium)。同步两个 ref,避免「切项目重置
  // genId」「project 反向同步」两个 effect 回头清掉这次 gen。
  const loadedGenProject = poll?.generation.projectId ?? null;
  useEffect(() => {
    // 仅当这条 gen 是「URL/深链驱动」且数据确凿时,才让 projectId 跟随它的 projectId。
    // 三重闸门缺一不可,否则会与「手动切 Campaign」相互踩踏(url-test 回归根因):
    // ① poll 必须确为当前 genId 的数据(poll.generation.id===genId)——切项目重播种时
    //    genId 已变但 poll 滞后,用滞后的旧项目 projectId 会把刚切到的新项目又拽回去;
    // ② 地址栏 ?gen 必须正好等于 genId——手动切项目时 project 反向同步已把 ?gen 删掉
    //    (≠ genId),此刻 genId 只是短暂停在旧项目出图上、即将被重播种,不该跟随;
    // ③ 该 gen 的 projectId 确实与当前 projectId 不同才需要跟随。
    // 命中三者 = popstate/深链到 ?gen=(缺/错 ?project=)或点跨项目历史出图,才跟随。
    if (poll?.generation.id !== genId) return;
    if (!loadedGenProject || loadedGenProject === projectId) return;
    const cur = new URLSearchParams(window.location.search);
    if (cur.get("gen") !== genId) return;
    // 自己把 ?project= 补进地址栏(保留 ?gen=)—— 深链只带 ?gen= 时,这条 effect 若只
    // setProjectId 并把 lastUrlProjectRef 设成新值,下面的 project 反向同步 effect 会因
    // 「ref===projectId」直接早退、永远不写 ?project=,分享/刷新丢了 project 那一半
    // (Bugbot Medium)。这里直接写全 ?project=&gen= 再对齐 ref,project 同步 effect 保持
    // no-op(且不会走 `if(prev) delete gen` 把深链 gen 抹掉)。
    if (cur.get("project") !== loadedGenProject) {
      cur.set("project", loadedGenProject);
      window.history.replaceState(null, "", `${pathname}?${cur.toString()}`);
    }
    lastUrlProjectRef.current = loadedGenProject;
    prevProjectRef.current = loadedGenProject;
    setProjectId(loadedGenProject);
  }, [loadedGenProject, projectId, genId, poll, pathname]);

  // —— 修改优化(改图)/ 终选 / 交付归档 ——
  const qc = useQueryClient();
  // 局部重画的目标版本(画布选中的那张出图变体);蒙版覆盖层对它出图。
  const [maskTarget, setMaskTarget] = useState<GenerationVersion | null>(null);
  const [editInstr, setEditInstr] = useState("");
  const [editVid, setEditVid] = useState<string | null>(null);
  const [editJobId, setEditJobId] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "edit" | "final" | "export">(null);
  // 局部重画 —— 蒙版绘制覆盖层开关（迁移自 prd_agent 视觉创作）。
  const [maskOpen, setMaskOpen] = useState(false);

  // 改图 server-authoritative:POST→202→轮询 edit job→成功后刷新主 generation,
  // 新的子版本(parentVersionId)就会出现在变体条里。
  const { data: editPoll } = useQuery<{ job?: { status: string } }>({
    queryKey: ["brandai-edit", wsId, genId, editVid, editJobId],
    queryFn: () =>
      apiFetch(
        `/api/workspaces/${wsId}/generations/${genId}/versions/${editVid}/edit?jobId=${editJobId}`,
      ),
    enabled: !!editJobId && !!editVid && !!genId,
    refetchInterval: (q) => {
      const s = q.state.data?.job?.status;
      if (s === "SUCCEEDED" || s === "FAILED") return false;
      // §2.4 6-min 上界:改图卡死就停轮询(下面的计时器给出口),不无限转「改图中…」。
      if (
        editStartedAt.current > 0 &&
        Date.now() - editStartedAt.current > POLL_CAP_MS
      )
        return false;
      return 2500;
    },
  });
  // §2.4 改图中间态超时出口:超界则清掉 job(busy 解锁)+ 给可读出口,不卡死工具条。
  useEffect(() => {
    if (!editJobId) return;
    const t = setInterval(() => {
      if (
        editStartedAt.current > 0 &&
        Date.now() - editStartedAt.current > POLL_CAP_MS
      ) {
        setEditJobId(null);
        setEditVid(null);
        setMaskOpen(false);
        setActionErr("改图超时:可能仍在后台,请稍后在变体条查看或重试。");
        // 立即捞一次(可能刚好在超时边界完成)+ 开启有界续观察,让迟到子版本自动浮现。
        qc.invalidateQueries({ queryKey: ["brandai-gen", wsId, genId] });
        setEditWatchUntil(Date.now() + POLL_CAP_MS);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [editJobId, qc, wsId, genId]);
  useEffect(() => {
    const s = editPoll?.job?.status;
    if (s === "SUCCEEDED") {
      setEditJobId(null);
      setEditVid(null);
      setEditInstr("");
      setMaskOpen(false); // 局部重画成功 → 关闭蒙版覆盖层，新子版本浮现在变体条
      setEditWatchUntil(0); // 正常完成 → 关掉续观察
      qc.invalidateQueries({ queryKey: ["brandai-gen", wsId, genId] });
    } else if (s === "FAILED") {
      setEditJobId(null);
      setMaskOpen(false);
      setActionErr("改图失败,请重试");
    }
  }, [editPoll, qc, wsId, genId]);
  // 切换查看的出图 → 关掉上一张的续观察,避免跨 generation 无谓慢轮询;并关闭还开着的
  // 蒙版覆盖层 —— 否则 maskTarget 仍钉在旧 gen 的版本,确认时 runEdit 会拿旧 versionId
  // 打到当前 genId(打错 generation / 报错,覆盖层还显示旧图)(Bugbot High)。
  useEffect(() => {
    setEditWatchUntil(0);
    setMaskOpen(false);
    setMaskTarget(null);
    // 同时停掉上一张的改图轮询 —— 否则 editVid/editJobId 仍指旧 gen 的版本,轮询会拿旧
    // jobId 打到当前 genId 的版本 URL(打错 generation),UI 卡「改图中…」到超时、成功
    // 回调还可能刷错 generation(Bugbot High)。改图 server-authoritative,离开后照常在
    // 后台完成,回到该 gen 时子版本随 generation 轮询自然浮现。
    setEditJobId(null);
    setEditVid(null);
    // 快捷编辑指令也清 —— 否则切到别的 generation 后工具条还留着上一张的指令文本,
    // 对新图 arm 一个操作时可能带着旧 prompt 出图(Bugbot Low)。
    setEditInstr("");
  }, [genId]);
  // F11 — refresh the quota bar once a generation completes so the displayed
  // 本周期/今日 用量 matches server-side enforcement without a manual reload.
  const quotaInvalidatedRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      status === "SUCCEEDED" &&
      genId &&
      quotaInvalidatedRef.current !== genId
    ) {
      quotaInvalidatedRef.current = genId;
      qc.invalidateQueries({ queryKey: ["brandai-quota", wsId] });
      // 让刚出图的这次进入历史缩略条（回看列表 newest-first）。
      qc.invalidateQueries({
        queryKey: ["brandai-project-gens", wsId, projectId],
      });
    }
  }, [status, genId, wsId, projectId, qc]);
  // E · 实时出图到达 SUCCEEDED 后清掉 jobId,让上面的 ?gen= 反向同步把这次出图写回
  // URL(刷新/分享落到刚生成的这张)。否则 submit() 设的 jobId 整个会话不清,
  // 反向同步的 `if (jobId) return` 永远挡住,新出的图分享不出去(Bugbot)。
  // 只在 SUCCEEDED 清:FAILED 仍需保留 jobId,否则轮询会丢掉 ?jobId= 携带的
  // failedReason。改图流同样在终态清 editJobId,此处对齐。
  useEffect(() => {
    if (jobId && status === "SUCCEEDED") setJobId(null);
  }, [status, jobId]);

  useEffect(() => {
    if (!current?.id) return;
    if (!editBaseVersionId || !versions.some((v) => v.id === editBaseVersionId)) {
      setEditBaseVersionId(current.id);
    }
  }, [current?.id, editBaseVersionId, versions]);

  // G6 · 审阅 / 批准流 — 拿调用者在本空间的角色，决定显示哪些审核动作。
  // EDITOR/OWNER 可「提交审阅」；REVIEWER/OWNER 可「批准 / 驳回」。
  const { data: membersData } = useQuery<ListMembersResponse>({
    queryKey: ["brandai-members", wsId],
    queryFn: () =>
      apiFetch<ListMembersResponse>(`/api/workspaces/${wsId}/members`),
    enabled: !!wsId,
  });
  const myRole: WorkspaceRole | null = membersData?.myRole ?? null;
  const canSubmitReview = myRole === "OWNER" || myRole === "EDITOR";
  const canDecideReview = myRole === "OWNER" || myRole === "REVIEWER";

  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  // 驳回时附理由（可选）。
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState("");

  async function submitForReview() {
    if (!current || !genId) return;
    setReviewErr(null);
    setReviewBusy(true);
    try {
      await apiFetch(
        `/api/workspaces/${wsId}/generations/${genId}/versions/${current.id}/submit`,
        { method: "POST" },
      );
      qc.invalidateQueries({ queryKey: ["brandai-gen", wsId, genId] });
    } catch (e) {
      setReviewErr(e instanceof Error ? e.message : "提交审阅失败");
    } finally {
      setReviewBusy(false);
    }
  }

  async function decideReview(
    decision: "APPROVED" | "REJECTED",
    note?: string,
  ) {
    if (!current || !genId) return;
    setReviewErr(null);
    setReviewBusy(true);
    try {
      await apiFetch(
        `/api/workspaces/${wsId}/generations/${genId}/versions/${current.id}/review`,
        {
          method: "POST",
          body: JSON.stringify({
            decision,
            ...(note?.trim() ? { note: note.trim() } : {}),
          }),
        },
      );
      setRejectOpen(false);
      setRejectNote("");
      qc.invalidateQueries({ queryKey: ["brandai-gen", wsId, genId] });
    } catch (e) {
      setReviewErr(e instanceof Error ? e.message : "审批失败");
    } finally {
      setReviewBusy(false);
    }
  }

  // 统一的改图提交入口：换背景/改色/局部重画(INPAINT+mask)/扩展(OUTPAINT) 全走这里
  // → POST /edit(202) → 轮询 edit job → 成功后新子版本(parentVersionId)浮现在变体条。
  // 统一改图入口:换背景/改色/局部重画(INPAINT+mask)/扩展(OUTPAINT) 全走这里 →
  // POST /edit(202) → 轮询 edit job → 成功后新子版本随 versions 浮现到画布。
  async function runEdit(
    op: string,
    payload: Record<string, unknown>,
    target?: GenerationVersion,
  ) {
    const v = target ?? current;
    if (!v || !genId) return;
    // 目标版本必须属于当前 genId —— 缩略图/历史/popstate 切了 generation 后,钉住的
    // maskTarget 或迟到的 target 可能仍指向旧 gen 的版本,若照发会打到 /generations/
    // {当前genId}/versions/{旧versionId}(打错 generation / 404)(Bugbot High)。
    if (v.generationId !== genId) {
      setActionErr("已切换到其他出图,请重新选中目标版本再改图。");
      return;
    }
    setActionErr(null);
    setBusy("edit");
    try {
      // 带上源版本“真实像素尺寸” —— 否则 AI /v1/edit 缺 width/height 会默认 1024²,非方图
      // (小红书封面/Banner)会被改成方图却按原比例存/导出,子版本尺寸对不上(Codex P2)。
      // 且必须用 params.actualWidth/Height(OpenAI snap 后的真实字节尺寸)而非请求 width/
      // height,否则局部重画蒙版按请求尺寸导出、_build_inpaint_mask 再 resize 到真实字节
      // 会错位(Codex P2)。payload 显式给的尺寸优先(目前没有,留作扩展)。
      const px = versionPixelSize(v);
      const sized: Record<string, unknown> = {
        width: px.width,
        height: px.height,
        ...payload,
      };
      const r = await apiFetch<{ jobId: string }>(
        `/api/workspaces/${wsId}/generations/${genId}/versions/${v.id}/edit`,
        {
          method: "POST",
          body: JSON.stringify({
            op,
            payload: sized,
            ...(activeWatermarkOverlays.length
              ? {
                  watermarkOverlays: activeWatermarkOverlays,
                }
              : {}),
          }),
        },
      );
      editStartedAt.current = Date.now();
      setEditVid(v.id);
      setEditJobId(r.jobId);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "改图提交失败");
    } finally {
      setBusy(null);
    }
  }

  // 局部重画浮动入口:对画布选中的出图变体打开蒙版绘制覆盖层。
  function openMaskPaint(target?: GenerationVersion) {
    const v = target ?? current;
    if (!v?.imageUrl) return;
    setActionErr(null);
    setMaskTarget(v);
    setMaskOpen(true);
  }

  // 蒙版确认 → op=INPAINT + payload.mask(涂抹蒙版 data-URI) + prompt(指令)。
  function confirmMaskEdit(maskDataUri: string, instruction: string) {
    void runEdit(
      "INPAINT",
      { prompt: instruction, mask: maskDataUri },
      maskTarget ?? current,
    );
  }

  // 画布单选某出图变体 → 同步 activeVariant(右下终选/导出/审阅对它生效)。
  const onCanvasSelectVersion = useCallback(
    (versionId: string | null) => {
      // 画布清掉版本选择(点空白/多选)→ 熄灭变体条高亮(current 仍保留),避免割裂。
      if (!versionId) {
        setCanvasSel(false);
        return;
      }
      // 注意：这里是「选择同步」回调（activeVersionId/selectNonce/回调身份变化都会
      // 重放），不能承载对话 Tab 的点选插入——那走 onUserPickVersion（真实点击专用），
      // 否则切到对话 Tab 的瞬间会凭空插入一个引用 chip（灰度自验收捕获的真 bug）。
      setCanvasSel(true);
      setEditBaseVersionId(versionId);
      setActiveVariant((prev) => {
        const idx = versions.findIndex((x) => x.id === versionId);
        return idx >= 0 ? idx : prev;
      });
    },
    [versions],
  );

  // V0.0.13d — 用户真实点击画布图片（出图变体 / 上传图 / 素材）= 点选引用
  // （replace；Shift/Ctrl 累加）。与选择同步分离（onUserPickImage 只在真实
  // pointer tap 时触发，程序化同步不触发）。
  const onCanvasUserPickImage = useCallback(
    (
      pick: { versionId?: string; assetId?: string; imageUrl: string },
      opts: { additive: boolean },
    ) => {
      if (pick.versionId) {
        const picked = versions.find((x) => x.id === pick.versionId);
        // 点选的是历史 generation 的累积 tile（不在当前 gen 的 versions 里）→
        // 顺带把工作台切到该次出图，否则 soloVersion 解析不到、选中后没有
        // 改图/终稿/导出/审阅 操作条（Codex P2；改图等端点也按 genId 作用域）。
        if (!picked) {
          const owner = history.find((g) =>
            (g.versions ?? []).some((v) => v.id === pick.versionId),
          );
          if (owner) viewGeneration(owner.id);
        }
        chatPickImage(
          {
            kind: "VERSION",
            id: pick.versionId,
            url: picked?.imageUrl || pick.imageUrl,
            label: "画布图",
          },
          opts,
        );
        return;
      }
      if (pick.assetId) {
        chatPickImage(
          { kind: "ASSET", id: pick.assetId, url: pick.imageUrl, label: "上传图" },
          opts,
        );
      }
    },
    // viewGeneration 是组件体内声明的函数（身份随渲染变化），与 versions 同列
    // 依赖即可——本回调本就随 versions 变化重建。
    [versions, history, chatPickImage, viewGeneration],
  );

  // 上传图片到画布:走真实素材上传(R2)→ 公网 URL + 真实尺寸(从 resolution 串解析)。
  const onCanvasUploadImage = useCallback(
    async (file: File) => {
      validateImageUploadFile(file);
      const fd = new FormData();
      fd.append("file", file);
      fd.append("category", "OTHER");
      const res = await fetch(`/api/workspaces/${wsId}/assets/upload`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "上传失败");
      }
      const a = (await res.json()) as {
        id: string;
        url: string;
        resolution?: string;
      };
      let width: number | undefined;
      let height: number | undefined;
      const m = a.resolution?.match(/(\d+)\D+(\d+)/);
      if (m) {
        width = Number(m[1]);
        height = Number(m[2]);
      }
      // 走同源代理 URL(/assets/:id/raw)而非存储对象 URL —— 配了 browser 不可达/内网
      // origin 的对象存储时,直接用 a.url 会往画布塞一张打不开的 <img>;全站素材都经
      // assetThumbUrl 代理正是为此(Codex P2)。
      return {
        url: assetThumbUrl(wsId, a.id, a.url),
        width,
        height,
        assetId: a.id,
      };
    },
    [wsId],
  );

  async function markFinal() {
    if (!current || !genId) return;
    setActionErr(null);
    setBusy("final");
    try {
      await apiFetch(`/api/workspaces/${wsId}/generations/${genId}`, {
        method: "PATCH",
        body: JSON.stringify({ versionId: current.id }),
      });
      qc.invalidateQueries({ queryKey: ["brandai-gen", wsId, genId] });
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "设为终稿失败");
    } finally {
      setBusy(null);
    }
  }

  async function exportKit() {
    if (!projectId) return;
    const finals = versions.filter((v) => v.isFinal).map((v) => v.id);
    const ids = finals.length > 0 ? finals : current ? [current.id] : [];
    if (ids.length === 0) return;
    setActionErr(null);
    setBusy("export");
    try {
      const res = await fetch(
        `/api/workspaces/${wsId}/projects/${projectId}/export`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ versionIds: ids }),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "导出失败");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "brandai-delivery.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : "导出失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
        {/* F1 · 顶部项目路径 breadcrumb — 品牌 / 项目名（可切换 + 回项目列表）/ 工作台 */}
        <nav
          aria-label="项目路径"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Link
            href="/campaigns"
            className="font-medium text-foreground transition-colors hover:text-primary"
            title="返回项目列表"
          >
            {brandName}
          </Link>
          <span aria-hidden className="text-muted-foreground/60">
            /
          </span>
          <span className="inline-flex items-center gap-1">
            <select
              value={projectId ?? ""}
              onChange={(e) => setProjectId(e.target.value || null)}
              aria-label="当前项目"
              className="max-w-[16rem] rounded-lg border border-border bg-background px-2 py-1 text-sm font-medium text-foreground outline-none focus:border-primary/40"
            >
              {projects.length === 0 ? (
                <option value="">无项目，请先去项目页创建</option>
              ) : null}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Link
              href="/campaigns"
              aria-label="返回项目列表"
              title="返回项目列表"
              className="text-xs text-muted-foreground transition-colors hover:text-primary"
            >
              ↩
            </Link>
          </span>
          <span aria-hidden className="text-muted-foreground/60">
            /
          </span>
          <span className="font-medium text-foreground">工作台</span>
        </nav>
        <div className="flex items-center gap-3">
          <StatusPill status={status} timedOut={timedOut} />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_340px]">
        {/* Canvas */}
        <div className="flex min-h-0 flex-col bg-background p-4">
          <OpenCanvas
            seedVersions={versions}
            running={running}
            status={status}
            timedOut={timedOut}
            error={
              poll?.job?.failedReason ?? poll?.generation.error ?? undefined
            }
            onSelectVersion={onCanvasSelectVersion}
            activeVersionId={current?.id ?? null}
            selectNonce={selectNonce}
            fitKey={genId ?? undefined}
            onUploadImage={onCanvasUploadImage}
            onUserPickImage={onCanvasUserPickImage}
            onBlankClick={() => chatInsertRef.current?.clearPending()}
            chatRefStates={chatRefStatesMap}
            persist={projectId ? { wsId, projectId } : undefined}
            uploadFilesRef={chatUploadFilesRef}
            edit={{
              ops: CANVAS_OPS,
              busy: !!editJobId || busy === "edit",
              instr: editInstr,
              onInstrChange: setEditInstr,
              onRun: (version, op) =>
                void runEdit(op, { prompt: editInstr.trim() }, version),
              onOpenMask: (version) => openMaskPaint(version),
              // V0.0.13e — 终选/交付/审阅挪进画布选中工具条（原下方面板已删）。
              delivery: current
                ? {
                    isFinal: !!current.isFinal,
                    hasFinal: versions.some((v) => v.isFinal),
                    busy,
                    error: actionErr,
                    onMarkFinal: () => void markFinal(),
                    onExport: () => void exportKit(),
                    reviewStatus:
                      current.reviewStatus === "PENDING"
                        ? null
                        : (current.reviewStatus ?? null),
                    canSubmitReview,
                    canDecideReview,
                    reviewBusy,
                    onSubmitReview: () => void submitForReview(),
                    onApprove: () => void decideReview("APPROVED"),
                    onOpenReject: () => {
                      setReviewErr(null);
                      setRejectNote("");
                      setRejectOpen(true);
                    },
                  }
                : undefined,
            }}
          />
        </div>

        {/* Prompt panel */}
        <aside className="flex min-h-0 flex-col overflow-hidden border-l border-border bg-card p-6">
          {/* V0.0.13d — 生成面板已删除：AI 设计师对话是唯一右栏（用户指令，
              对齐 prd_agent 视觉创作「画布 + 对话」单面板形态）。 */}
          <ChatPanel
            wsId={wsId}
            projectId={projectId}
            sceneType={sceneType}
            onViewGeneration={viewGeneration}
            onSubmitted={onChatSubmitted}
            insertRef={chatInsertRef}
            onComposerRefsChange={setChatComposerRefs}
            onPasteImage={(files) => chatUploadFilesRef.current?.(files)}
          />
        </aside>
      </div>

      {/* G6 · 驳回弹窗 — 可选附理由（reviewNote），走真实 review 端点。 */}
      {rejectOpen ? (
        <RejectDialog
          note={rejectNote}
          submitting={reviewBusy}
          error={reviewErr}
          onChange={setRejectNote}
          onCancel={() => {
            setRejectOpen(false);
            setReviewErr(null);
          }}
          onConfirm={() => void decideReview("REJECTED", rejectNote)}
        />
      ) : null}

      {/* 局部重画 · 蒙版绘制覆盖层（迁移自 prd_agent 视觉创作）。涂抹重绘区 + 指令 →
          op=INPAINT + payload.mask 走真实改图链路；提交中保持打开给出反馈，终态自动关闭。 */}
      {maskOpen && (maskTarget ?? current)?.imageUrl ? (
        <MaskPaintCanvas
          imageSrc={(maskTarget ?? current)!.imageUrl}
          imageWidth={versionPixelSize((maskTarget ?? current)!).width}
          imageHeight={versionPixelSize((maskTarget ?? current)!).height}
          submitting={!!editJobId || busy === "edit"}
          onConfirm={confirmMaskEdit}
          onCancel={() => setMaskOpen(false)}
        />
      ) : null}
    </div>
  );
}

function AssetThumb({ asset, alt }: { asset: RefAsset; alt: string }) {
  return (
    <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-border">
      {asset.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={asset.thumbUrl}
          alt={alt}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          ◇
        </div>
      )}
    </div>
  );
}

function WatermarkEditorDialog({
  wsId,
  assets,
  overlays,
  onChange,
  onClose,
}: {
  wsId: string;
  assets: RefAsset[];
  overlays: WatermarkOverlayInput[];
  onChange: (next: WatermarkOverlayInput[]) => void;
  onClose: () => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(
    overlays[0]?.assetId ?? null,
  );
  const [presetName, setPresetName] = useState("默认水印");
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const watermarkResizeRef = useRef<{ x: number; width: number } | null>(null);
  const presetBootstrapped = useRef(false);
  const activeIndex = Math.max(
    0,
    overlays.findIndex((o) => o.assetId === activeId),
  );
  const active =
    overlays[activeIndex] ?? defaultWatermarkOverlay(activeId ?? undefined);
  const activeAsset = assets.find((a) => a.id === active.assetId) ?? assets[0];
  const { data: presets = [], refetch } = useQuery({
    queryKey: ["brandai-watermark-presets", wsId],
    queryFn: () =>
      apiFetch<WatermarkPreset[]>(`/api/workspaces/${wsId}/watermark-presets`),
  });
  useEffect(() => {
    if (presetBootstrapped.current || editingPresetId || presets.length === 0)
      return;
    const firstEditable =
      presets.find((preset) => preset.isActive) ?? presets[0];
    if (!firstEditable) return;
    presetBootstrapped.current = true;
    setEditingPresetId(firstEditable.id);
    setPresetName(firstEditable.name);
  }, [editingPresetId, presets]);

  function patchActive(patch: Partial<WatermarkOverlayInput>) {
    const next = overlays.map((overlay, idx) =>
      idx === activeIndex ? { ...overlay, ...patch } : overlay,
    );
    onChange(next);
  }

  function applyPreset(preset: WatermarkPreset) {
    patchActive({ ...preset.config, assetId: active.assetId });
    setPresetName(preset.name);
    setEditingPresetId(preset.id);
  }

  async function savePreset() {
    const payload = {
      name: presetName.trim() || "默认水印",
      isActive: true,
      config: active,
    };
    const saved = await apiFetch<WatermarkPreset>(
      editingPresetId
        ? `/api/workspaces/${wsId}/watermark-presets/${editingPresetId}`
        : `/api/workspaces/${wsId}/watermark-presets`,
      {
        method: editingPresetId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      },
    );
    setEditingPresetId(saved.id);
    setPresetName(saved.name);
    await refetch();
  }

  function newPresetDraft() {
    presetBootstrapped.current = true;
    setEditingPresetId(null);
    setPresetName("默认水印");
    patchActive(defaultWatermarkOverlay(active.assetId));
  }

  function onPreviewPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const box = previewRef.current;
    if (!box) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    updatePositionFromPointer(e.clientX, e.clientY);
  }

  function beginWatermarkResize(e: ReactPointerEvent<HTMLSpanElement>) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    watermarkResizeRef.current = { x: e.clientX, width: active.widthPx };
  }

  function moveWatermarkResize(e: ReactPointerEvent<HTMLSpanElement>) {
    const start = watermarkResizeRef.current;
    if (!start) return;
    const delta = e.clientX - start.x;
    patchActive({ widthPx: Math.max(40, Math.min(360, start.width + delta)) });
  }

  function updatePositionFromPointer(clientX: number, clientY: number) {
    const box = previewRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const anchor =
      x < rect.width / 2
        ? y < rect.height / 2
          ? "top-left"
          : "bottom-left"
        : y < rect.height / 2
          ? "top-right"
          : "bottom-right";
    const wmW = Math.min(rect.width * 0.45, active.widthPx);
    const wmH = 48;
    const offsetX =
      anchor === "top-left" || anchor === "bottom-left"
        ? Math.max(0, x - wmW / 2)
        : Math.max(0, rect.width - x - wmW / 2);
    const offsetY =
      anchor === "top-left" || anchor === "top-right"
        ? Math.max(0, y - wmH / 2)
        : Math.max(0, rect.height - y - wmH / 2);
    patchActive({
      anchor,
      positionMode: "pixel",
      offsetX: Math.round(offsetX),
      offsetY: Math.round(offsetY),
    });
  }

  const previewStyle = (() => {
    const width = Math.min(180, Math.max(60, active.widthPx));
    const height = 56;
    const pos: CSSProperties = { width, height };
    if (active.anchor.includes("left")) pos.left = active.offsetX;
    else pos.right = active.offsetX;
    if (active.anchor.includes("top")) pos.top = active.offsetY;
    else pos.bottom = active.offsetY;
    return pos;
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="grid max-h-[88vh] w-full max-w-6xl grid-cols-[260px_minmax(360px,1fr)_320px] overflow-hidden rounded-3xl border border-border bg-card shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="border-r border-border bg-background/70 p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-lg font-semibold">LOGO 与水印</div>
              <div className="mt-1 text-xs text-muted-foreground">
                配置会在生成后确定性叠加。
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted"
            >
              ✕
            </button>
          </div>
          <div className="mb-3 text-xs font-semibold text-muted-foreground">
            水印素材
          </div>
          <div className="space-y-2">
            {assets.map((asset) => {
              const on = asset.id === active.assetId;
              return (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => setActiveId(asset.id)}
                  className={[
                    "flex w-full items-center gap-2 rounded-2xl border p-2 text-left transition-colors",
                    on
                      ? "border-primary bg-accent-soft text-primary"
                      : "border-border bg-card hover:bg-muted",
                  ].join(" ")}
                >
                  <AssetThumb asset={asset} alt="水印素材" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {asset.fileName ?? "素材"}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-5 border-t border-border pt-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-muted-foreground">
                已保存配置
              </span>
              <button
                type="button"
                onClick={newPresetDraft}
                className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
              >
                新建
              </button>
            </div>
            <div className="space-y-2">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className={[
                    "w-full rounded-xl border px-3 py-2 text-left text-xs transition-colors hover:border-primary/30 hover:bg-accent-soft",
                    editingPresetId === preset.id
                      ? "border-primary bg-accent-soft text-primary"
                      : "border-border bg-card",
                  ].join(" ")}
                >
                  <span className="font-medium">{preset.name}</span>
                  {preset.isActive ? (
                    <span className="ml-2 rounded-full bg-success/10 px-2 py-0.5 text-[10px] text-success">
                      启用
                    </span>
                  ) : null}
                </button>
              ))}
              {presets.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-3 text-xs text-muted-foreground">
                  暂无保存配置
                </div>
              ) : null}
            </div>
          </div>
        </aside>

        <main className="flex flex-col bg-background p-6">
          <div
            ref={previewRef}
            className="relative min-h-[360px] flex-1 overflow-hidden rounded-3xl border border-border bg-[linear-gradient(#ECECF3_1px,transparent_1px),linear-gradient(90deg,#ECECF3_1px,transparent_1px)] bg-[size:24px_24px]"
          >
            <div className="absolute inset-6 rounded-[28px] border border-dashed border-primary/25 bg-card/70" />
            {(
              ["top-left", "top-right", "bottom-left", "bottom-right"] as const
            ).map((anchor) => (
              <div
                key={anchor}
                className={[
                  "absolute flex h-1/2 w-1/2 items-center justify-center text-xs text-muted-foreground/50",
                  anchor.includes("top") ? "top-0" : "bottom-0",
                  anchor.includes("left") ? "left-0" : "right-0",
                ].join(" ")}
              >
                {anchor === "top-left"
                  ? "左上"
                  : anchor === "top-right"
                    ? "右上"
                    : anchor === "bottom-left"
                      ? "左下"
                      : "右下"}
              </div>
            ))}
            <div
              role="button"
              tabIndex={0}
              onPointerDown={onPreviewPointerDown}
              onPointerMove={(e) => {
                if (e.buttons === 1)
                  updatePositionFromPointer(e.clientX, e.clientY);
              }}
              className="absolute z-10 flex cursor-move items-center justify-center overflow-hidden rounded-xl border border-primary bg-card shadow-[0_12px_26px_rgba(124,92,255,0.18)]"
              style={{ ...previewStyle, opacity: active.opacity }}
            >
              {activeAsset?.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={activeAsset.thumbUrl}
                  alt="水印预览"
                  className="h-full w-full object-contain"
                />
              ) : null}
              {active.text ? (
                <span className="absolute bottom-1 rounded-full bg-card/90 px-2 py-0.5 text-[10px] font-medium text-foreground">
                  {active.text}
                </span>
              ) : null}
              <span
                role="presentation"
                onPointerDown={beginWatermarkResize}
                onPointerMove={moveWatermarkResize}
                onPointerUp={(e) => {
                  watermarkResizeRef.current = null;
                  try {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  } catch {
                    /* noop */
                  }
                }}
                className="absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize rounded-full border-2 border-card bg-primary shadow"
                title="拖拽调整大小"
              />
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {active.anchor} ·{" "}
              {active.positionMode === "pixel" ? "像素" : "比例"}
            </span>
            <span>
              X {Math.round(active.offsetX)} · Y {Math.round(active.offsetY)}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            直接拖动画布里的水印调整位置，拖右下角圆点调整显示尺寸。
          </p>
        </main>

        <aside className="space-y-4 overflow-y-auto border-l border-border p-5">
          <label className="block text-xs font-semibold text-muted-foreground">
            配置名称
            <input
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              className="mt-2 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm font-normal text-foreground outline-none focus:border-primary/40"
            />
          </label>
          <ControlInput
            label="水印文字"
            value={active.text ?? ""}
            onChange={(v) => patchActive({ text: v })}
          />
          <div>
            <div className="mb-2 text-xs font-semibold text-muted-foreground">
              调用方式
            </div>
            <div className="space-y-2">
              {WATERMARK_INVOCATION_MODES.map((mode) => {
                const on = (active.invocationMode ?? "EXACT") === mode.value;
                return (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() =>
                      patchActive({
                        invocationMode: mode.value,
                        allowRecolor: mode.value === "ADAPTIVE",
                        lockAspectRatio: mode.value !== "REFERENCE",
                      })
                    }
                    className={[
                      "w-full rounded-xl border px-3 py-2 text-left transition-colors",
                      on
                        ? "border-primary bg-accent-soft text-primary"
                        : "border-border text-muted-foreground hover:bg-muted",
                    ].join(" ")}
                  >
                    <span className="block text-xs font-semibold">
                      {mode.label}
                    </span>
                    <span className="mt-1 block text-[10px] leading-relaxed">
                      {mode.hint}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <ControlRange
            label="大小"
            min={40}
            max={360}
            value={active.widthPx}
            onChange={(v) => patchActive({ widthPx: v })}
          />
          <ControlRange
            label="透明度"
            min={0.1}
            max={1}
            step={0.05}
            value={active.opacity}
            onChange={(v) => patchActive({ opacity: v })}
          />
          <div>
            <div className="mb-2 text-xs font-semibold text-muted-foreground">
              锚点
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  "top-left",
                  "top-right",
                  "bottom-left",
                  "bottom-right",
                ] as const
              ).map((anchor) => (
                <button
                  key={anchor}
                  type="button"
                  onClick={() => patchActive({ anchor })}
                  className={[
                    "rounded-xl border px-3 py-2 text-xs transition-colors",
                    active.anchor === anchor
                      ? "border-primary bg-accent-soft text-primary"
                      : "border-border text-muted-foreground hover:bg-muted",
                  ].join(" ")}
                >
                  {anchor}
                </button>
              ))}
            </div>
          </div>
          <ControlRange
            label="X 偏移"
            min={0}
            max={260}
            value={active.offsetX}
            onChange={(v) => patchActive({ offsetX: v })}
          />
          <ControlRange
            label="Y 偏移"
            min={0}
            max={260}
            value={active.offsetY}
            onChange={(v) => patchActive({ offsetY: v })}
          />
          <ToggleControl
            label="填充"
            checked={active.backgroundEnabled}
            onChange={(v) => patchActive({ backgroundEnabled: v })}
          />
          <ToggleControl
            label="边框"
            checked={active.borderEnabled}
            onChange={(v) => patchActive({ borderEnabled: v })}
          />
          <button
            type="button"
            onClick={() => void savePreset()}
            className="h-11 w-full rounded-2xl bg-primary text-sm font-medium text-primary-foreground shadow-[0_10px_24px_rgba(124,92,255,0.22)]"
          >
            保存配置
          </button>
        </aside>
      </div>
    </div>
  );
}

function ControlInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-xs font-semibold text-muted-foreground">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-2 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm font-normal text-foreground outline-none focus:border-primary/40"
      />
    </label>
  );
}

function ControlRange({
  label,
  min,
  max,
  step = 1,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block text-xs font-semibold text-muted-foreground">
      <span className="flex items-center justify-between">
        <span>{label}</span>
        <span>{Number(value).toFixed(step < 1 ? 2 : 0)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-primary"
      />
    </label>
  );
}

function ToggleControl({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={[
        "flex h-10 w-full items-center justify-between rounded-xl border px-3 text-xs font-semibold transition-colors",
        checked
          ? "border-primary bg-accent-soft text-primary"
          : "border-border text-muted-foreground hover:bg-muted",
      ].join(" ")}
    >
      <span>{label}</span>
      <span>{checked ? "启用" : "禁用"}</span>
    </button>
  );
}

function WorkspaceAssetPicker({
  wsId,
  libraryKind,
  title,
  description,
  existingIds,
  onClose,
  onAdd,
}: {
  wsId: string;
  libraryKind: "MATERIAL" | "TEMPLATE";
  title: string;
  description: string;
  existingIds: string[];
  onClose: () => void;
  onAdd: (items: RefAsset[]) => void;
}) {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const { data: assets = [], isLoading } = useQuery({
    queryKey: ["brandai-assets", wsId, "workspace-picker", libraryKind],
    queryFn: () =>
      apiFetch<Asset[]>(
        `/api/workspaces/${wsId}/assets?libraryKind=${libraryKind}`,
      ),
  });
  const existing = new Set(existingIds);
  const needle = q.trim().toLowerCase();
  const candidates = assets.filter((asset) => {
    if (!(asset.mimeType ?? "").startsWith("image/")) return false;
    if (asset.availableForGeneration === false || asset.deprecatedAt)
      return false;
    if (!needle) return true;
    return [
      asset.fileName,
      asset.aiDescription ?? "",
      ...(asset.tags ?? []),
      ...(asset.aiTags ?? []),
    ]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
  function toggle(id: string) {
    if (existing.has(id)) return;
    setSelected((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );
  }
  const picked = candidates.filter((asset) => selected.includes(asset.id));
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-lg font-semibold">{title}</div>
              <p className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted"
            >
              ✕
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索名称、标签或描述…"
              className="h-10 flex-1 rounded-full border border-border bg-background px-4 text-sm outline-none focus:border-primary/40"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              加载中…
            </div>
          ) : candidates.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
              {libraryKind === "TEMPLATE"
                ? "模板库还没有可用参考图"
                : "没有可用于出图的图片素材"}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {candidates.map((asset) => {
                const disabled = existing.has(asset.id);
                const on = selected.includes(asset.id);
                return (
                  <button
                    key={asset.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => toggle(asset.id)}
                    className={[
                      "overflow-hidden rounded-2xl border bg-background text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                      on
                        ? "border-primary shadow-[0_8px_24px_rgba(124,92,255,0.14)]"
                        : "border-border hover:border-primary/30",
                    ].join(" ")}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={assetThumbUrl(wsId, asset.id, asset.url)}
                      alt={asset.fileName}
                      className="h-28 w-full object-cover"
                    />
                    <div className="p-3">
                      <div className="truncate text-xs font-medium">
                        {asset.fileName}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(asset.tags ?? []).slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] text-primary"
                          >
                            {tag}
                          </span>
                        ))}
                        {disabled ? (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                            已添加
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
          <span className="text-xs text-muted-foreground">
            已选 {picked.length} 个
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-10 rounded-full border border-border px-4 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              取消
            </button>
            <button
              type="button"
              disabled={picked.length === 0}
              onClick={() =>
                onAdd(
                  picked.map((asset) => ({
                    id: asset.id,
                    fileName: asset.fileName,
                    thumbUrl: assetThumbUrl(wsId, asset.id, asset.url),
                  })),
                )
              }
              className="h-10 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              添加到工作台
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * G6 · 审阅 / 批准面板 — 显示选中变体的 reviewStatus（PENDING / SUBMITTED /
 * APPROVED / REJECTED）+ 审核理由（reviewNote），并按调用者角色门控动作：
 *   - EDITOR / OWNER 可对 PENDING / REJECTED 版本「提交审阅」（→ SUBMITTED）。
 *   - REVIEWER / OWNER 可对 SUBMITTED 版本「批准 / 驳回」。
 * 终稿（isFinal）不再可审。全部接真实 submit / review 端点，语义 token only。
 */
function ReviewPanel({
  version,
  myRole,
  canSubmit,
  canDecide,
  busy,
  error,
  onSubmit,
  onApprove,
  onOpenReject,
}: {
  version: GenerationVersion;
  myRole: WorkspaceRole | null;
  canSubmit: boolean;
  canDecide: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
  onApprove: () => void;
  onOpenReject: () => void;
}) {
  const rs = version.reviewStatus ?? "PENDING";
  const meta: Record<string, { tone: Tone; label: string }> = {
    PENDING: { tone: "muted", label: "待提交审阅" },
    SUBMITTED: { tone: "primary", label: "审阅中" },
    APPROVED: { tone: "success", label: "已批准" },
    REJECTED: { tone: "danger", label: "已驳回" },
  };
  const m = meta[rs] ?? meta.PENDING!;

  // 可提交：PENDING / REJECTED 且非终稿（与 submit 端点的职责分离一致）。
  const submittable =
    canSubmit && !version.isFinal && (rs === "PENDING" || rs === "REJECTED");
  // 可审批：仅 SUBMITTED。
  const decidable = canDecide && rs === "SUBMITTED";

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground">
          审阅状态
        </span>
        <Pill tone={m.tone}>{m.label}</Pill>
      </div>

      {version.reviewNote ? (
        <p className="mt-2 rounded-xl bg-muted px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">审核意见：</span>
          {version.reviewNote}
        </p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap gap-2">
        {submittable ? (
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy}
            className="rounded-full bg-gradient-to-br from-primary to-accent px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-[0_8px_20px_rgba(124,92,255,0.22)] disabled:opacity-60"
          >
            {busy ? "提交中…" : rs === "REJECTED" ? "重新提交审阅" : "提交审阅"}
          </button>
        ) : null}
        {decidable ? (
          <>
            <button
              type="button"
              onClick={onApprove}
              disabled={busy}
              className="rounded-full border border-success/40 px-3 py-1.5 text-xs text-success transition-colors hover:bg-success/10 disabled:opacity-60"
            >
              批准
            </button>
            <button
              type="button"
              onClick={onOpenReject}
              disabled={busy}
              className="rounded-full border border-destructive/40 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
            >
              驳回
            </button>
          </>
        ) : null}
      </div>

      {/* 诚实空态：既不能提交也不能审批时，说明原因。 */}
      {!submittable && !decidable ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          {rs === "SUBMITTED"
            ? myRole
              ? "等待审核角色（审核 / 所有者）批准或驳回。"
              : "等待审核。"
            : rs === "APPROVED"
              ? "该版本已批准，可设为终稿并导出交付。"
              : myRole && !canSubmit
                ? "你的角色（查看）无提交审阅权限。"
                : "出图后可提交审阅。"}
        </p>
      ) : null}

      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * G6 · 驳回弹窗 — 驳回时可选附审核意见（reviewNote，≤500），走真实 review 端点
 * （decision=REJECTED）。语义 token only。
 */
function RejectDialog({
  note,
  submitting,
  error,
  onChange,
  onCancel,
  onConfirm,
}: {
  note: string;
  submitting: boolean;
  error: string | null;
  onChange: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold">驳回版本</div>
        <p className="mt-1 text-sm text-muted-foreground">
          可填写驳回理由，便于编辑修改后重新提交审阅。
        </p>
        <textarea
          value={note}
          maxLength={500}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          placeholder="如：主体偏色、负空间不足、文案需调整…"
          className="mt-4 w-full resize-none rounded-2xl border border-border bg-background p-3 text-sm outline-none focus:border-primary/40 focus:shadow-[0_0_0_4px_rgba(124,92,255,0.08)]"
        />
        <div className="mt-1 text-right text-[11px] text-muted-foreground">
          {note.length}/500
        </div>
        {error ? (
          <p className="mt-2 text-sm text-destructive">{error}</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="rounded-full bg-destructive px-5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-destructive/90 disabled:opacity-70"
          >
            {submitting ? "驳回中…" : "确认驳回"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * H9 · 提交制作确认弹窗 — summarize exactly what will be generated before firing
 * the real POST /generations flow, plus an honest note that it consumes quota.
 * Read-only summary; the actual generation is unchanged. Semantic tokens only.
 */
function ConfirmSubmitDialog({
  summary,
  submitting,
  onCancel,
  onConfirm,
}: {
  summary: {
    projectName: string;
    sceneType: string;
    scene: string;
    sceneSource: GenerationDefaultSource;
    sellingPoint: string;
    sellingPointSource: GenerationDefaultSource;
    count: number;
    multiSize: boolean;
    targets: string[];
    textMode: "direct" | "layered";
    styleKeywords: string[];
    referenceCount: number;
    quota: QuotaStatus | null;
  };
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const q = summary.quota;
  const periodText =
    q == null
      ? null
      : q.monthlyQuota === -1
        ? "本周期不限"
        : `本周期已用 ${q.periodUsed}/${q.monthlyQuota}`;
  const remaining =
    q && q.monthlyQuota !== -1 ? q.monthlyQuota - q.periodUsed : null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold">确认提交制作</div>
        <p className="mt-1 text-sm text-muted-foreground">
          确认后将提交至 AI 受控出图，请核对生成内容。
        </p>

        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
          <dt className="text-muted-foreground">项目</dt>
          <dd className="font-medium">{summary.projectName}</dd>
          <dt className="text-muted-foreground">画面类型</dt>
          <dd>{summary.sceneType}</dd>
          <dt className="text-muted-foreground">场景</dt>
          <dd>
            {summary.scene || "—"}
            {summary.sceneSource === "system" ? (
              <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                系统补全
              </span>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">生成数量</dt>
          <dd>
            {summary.multiSize
              ? `${summary.count} 张（多尺寸，每尺寸 1 张）`
              : `${summary.count} 张`}
          </dd>
          {summary.multiSize && summary.targets.length ? (
            <>
              <dt className="text-muted-foreground">尺寸</dt>
              <dd>{summary.targets.join("、")}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">文本策略</dt>
          <dd>{summary.textMode === "layered" ? "分层留白" : "直接出图"}</dd>
          {summary.styleKeywords.length ? (
            <>
              <dt className="text-muted-foreground">风格关键词</dt>
              <dd>{summary.styleKeywords.join("、")}</dd>
            </>
          ) : null}
          {summary.referenceCount ? (
            <>
              <dt className="text-muted-foreground">参考素材</dt>
              <dd>{summary.referenceCount} 张</dd>
            </>
          ) : null}
        </dl>

        <div className="mt-4 rounded-2xl bg-accent-soft/60 p-3.5 text-xs leading-relaxed text-foreground/80">
          <p className="line-clamp-3">
            <span className="font-medium text-foreground">需求 / 卖点：</span>
            {summary.sellingPoint || "（未填写）"}
            {summary.sellingPointSource === "system" ? (
              <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                系统补全
              </span>
            ) : null}
          </p>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          本次出图将消耗生成额度
          {periodText ? `（${periodText}` : ""}
          {periodText && remaining != null
            ? `，剩余 ${Math.max(0, remaining)}）`
            : periodText
              ? "）"
              : ""}
          。
        </p>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="rounded-full bg-gradient-to-br from-primary to-accent px-5 py-2 text-sm font-medium text-primary-foreground shadow-[0_8px_20px_rgba(124,92,255,0.24)] disabled:opacity-70"
          >
            {submitting ? "提交中…" : "确认出图"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * H12 · 额度升级弹窗 — show the current quota (from GET /quota) + plan tiers.
 * Phase-1 has no real billing, so tiers are informational and the CTA is
 * "contact to upgrade" (honest — never fakes a payment). Semantic tokens only.
 */
function UpgradeDialog({
  quota,
  onClose,
}: {
  quota: QuotaStatus | null;
  onClose: () => void;
}) {
  const currentPlan = quota?.plan ?? null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-border bg-card p-6 shadow-[0_24px_70px_rgba(30,30,60,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold">升级套餐 · 提升出图额度</div>
        <p className="mt-1 text-sm text-muted-foreground">
          按品牌规范受控出图，额度越高可批量产出越多营销物料。
        </p>

        {quota ? (
          <div className="mt-4 rounded-2xl border border-border bg-background p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">当前套餐</span>
              <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-primary">
                {quota.plan}
              </span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              本周期{" "}
              <span className="font-medium text-foreground">
                {quota.periodUsed}/
                {quota.monthlyQuota === -1 ? "不限" : quota.monthlyQuota}
              </span>{" "}
              · 今日{" "}
              <span className="font-medium text-foreground">
                {quota.dailyUsed}/
                {quota.dailyLimit === -1 ? "不限" : quota.dailyLimit}
              </span>
            </p>
          </div>
        ) : null}

        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {planTiers.map((tier) => {
            const isCurrent = currentPlan === tier.planKey;
            return (
              <div
                key={tier.planKey}
                className={[
                  "flex flex-col rounded-2xl border p-4",
                  tier.highlight
                    ? "border-primary/40 bg-accent-soft/40"
                    : "border-border bg-background",
                ].join(" ")}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{tier.name}</span>
                  {isCurrent ? (
                    <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-primary">
                      当前
                    </span>
                  ) : tier.highlight ? (
                    <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">
                      推荐
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-lg font-semibold text-primary">
                  {tier.priceLabel}
                </div>
                <ul className="mt-3 flex flex-1 flex-col gap-1.5 text-xs text-muted-foreground">
                  {tier.features.map((f) => (
                    <li key={f} className="flex gap-1.5">
                      <span className="text-primary">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="mt-5 rounded-2xl bg-accent-soft/60 p-3.5 text-xs leading-relaxed text-foreground/80">
          一期为内部专属部署，套餐升级请联系{" "}
          <a
            href={`mailto:${upgradeContactEmail}`}
            className="font-medium text-primary underline underline-offset-2"
          >
            {upgradeContactEmail}
          </a>
          。在线自助计费将在后续多租户版本提供。
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
          >
            知道了
          </button>
          <a
            href={`mailto:${upgradeContactEmail}?subject=BrandAI 套餐升级咨询`}
          >
            <button
              type="button"
              className="rounded-full bg-gradient-to-br from-primary to-accent px-5 py-2 text-sm font-medium text-primary-foreground shadow-[0_8px_20px_rgba(124,92,255,0.24)]"
            >
              联系升级
            </button>
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * F2 / L6 — workspace top toolbar: undo/redo for the generation-form state and
 * zoom controls (in / out / reset 100% / fit) for the big preview. Pure
 * client-side; buttons disable at their bounds. Uses semantic tokens only.
 */
function Toolbar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const btn =
    "flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex items-center gap-0.5 rounded-xl border border-border bg-background p-0.5">
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        aria-label="撤销"
        title="撤销 (表单)"
        className={btn}
      >
        ↶
      </button>
      <button
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        aria-label="重做"
        title="重做 (表单)"
        className={btn}
      >
        ↷
      </button>
    </div>
  );
}

function StatusPill({
  status,
  timedOut,
}: {
  status: string | null;
  timedOut: boolean;
}) {
  if (timedOut) return <Pill tone="warning">超时，请重试</Pill>;
  if (!status) return null;
  const map: Record<string, { tone: Tone; label: string }> = {
    PENDING: { tone: "muted", label: "已受理 · 排队中" },
    RUNNING: { tone: "primary", label: "生成中…" },
    SUCCEEDED: { tone: "success", label: "已完成" },
    FAILED: { tone: "danger", label: "失败" },
  };
  const m = map[status] ?? { tone: "muted" as Tone, label: status };
  return <Pill tone={m.tone}>{m.label}</Pill>;
}

type Tone = "muted" | "primary" | "success" | "danger" | "warning";

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const map: Record<Tone, string> = {
    muted: "bg-muted text-muted-foreground",
    primary: "bg-accent-soft text-primary",
    success: "bg-success/10 text-success",
    danger: "bg-destructive/10 text-destructive",
    warning: "bg-warning/10 text-warning",
  };
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-medium ${map[tone]}`}>
      {children}
    </span>
  );
}

// F11 — compact period/day usage with a violet bar. -1 = 不限. H12 — 升级入口.
function QuotaBar({
  quota,
  onUpgrade,
}: {
  quota: {
    dailyUsed: number;
    dailyLimit: number;
    periodUsed: number;
    monthlyQuota: number;
    plan: string;
  };
  onUpgrade: () => void;
}) {
  const { periodUsed, monthlyQuota, dailyUsed, dailyLimit, plan } = quota;
  const monthlyText = monthlyQuota === -1 ? "不限" : monthlyQuota;
  const dailyText = dailyLimit === -1 ? "不限" : dailyLimit;
  const pct =
    monthlyQuota > 0
      ? Math.min(100, Math.round((periodUsed / monthlyQuota) * 100))
      : monthlyQuota === -1
        ? 0
        : 100;
  return (
    <div className="rounded-2xl border border-border bg-background p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="font-medium text-foreground">生成额度</span>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-primary">
            {plan}
          </span>
          <button
            type="button"
            onClick={onUpgrade}
            className="rounded-full border border-primary/30 px-2 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-accent-soft"
          >
            升级
          </button>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        本周期{" "}
        <span className="font-medium text-foreground">
          {periodUsed}/{monthlyText}
        </span>{" "}
        · 今日{" "}
        <span className="font-medium text-foreground">
          {dailyUsed}/{dailyText}
        </span>
      </p>
      {monthlyQuota !== -1 ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-accent-soft">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

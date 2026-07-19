"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type { GenerationVersion } from "@brandai/contracts";

/**
 * 开放世界画布 —— 迁移自 prd_agent 视觉创作 AdvancedVisualAgentTab 的无限平面画布
 * (P1 底座)。重做成 BrandAI 紫色语义 token + Next15/React19,纯客户端态(持久化 P3)。
 *
 * 坐标系: world↔screen 为 `screen = world*zoom + camera`;item 用屏幕像素绝对定位,
 * 选择手柄固定屏幕尺寸不随缩放变形。手势对齐 .claude/rules/gesture-unification 标准 A:
 * ⌘/Ctrl+滚轮缩放(光标定点)、两指/滚轮平移、手型/空格拖动平移、双击不缩放。
 *
 * 元素: image(出图变体/上传图) · shape(矩形/圆/三角/星) · text。支持选择/框选、
 * 拖拽(多选)、缩放(四角,图片锁比例)、图层(置顶/底/上/下移)、删除。单选某张「出图
 * 变体」(带 versionId)时,上方浮现操作条(局部重画/扩展/换背景… 接真实改图链路)。
 */

export type CanvasItemKind = "image" | "shape" | "text";
export type ShapeType = "rect" | "circle" | "triangle" | "star";

export type CanvasItem = {
  key: string;
  kind: CanvasItemKind;
  x: number;
  y: number;
  w: number;
  h: number;
  // image
  imageUrl?: string;
  versionId?: string; // 出图变体来源(可对其改图);上传/外部图为空
  assetId?: string; // 上传/素材来源(可被对话面板引用为 ASSET 图像输入)
  naturalW?: number;
  naturalH?: number;
  /** 上传同步态（仅本地内存，不持久化）：pending=本地预览已上画布、资产上传中；
   *  failed=上传失败（刷新会丢）。undefined/synced=已持久。 */
  syncStatus?: "pending" | "synced" | "failed";
  // shape
  shapeType?: ShapeType;
  fill?: string;
  stroke?: string;
  // text
  text?: string;
  fontSize?: number;
  color?: string;
};

type DraggedAsset = {
  id: string;
  url?: string;
  fileName?: string;
  width?: number;
  height?: number;
};

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4;
const MIN_SIZE = 32;
const VIOLET = "rgb(124 92 255)";
const SELECT = "#4A9BFF"; // 与既有工作台选择框一致

let __k = 0;
function uid(prefix: string) {
  __k += 1;
  return `${prefix}-${__k}-${String(Math.floor((__k * 2654435761) % 1e6))}`;
}

function imageItemFromVersion(v: GenerationVersion, idx: number): CanvasItem {
  const ratio = v.width && v.height ? v.width / v.height : 1;
  const baseW = 280;
  const baseH = Math.round(baseW / (ratio || 1));
  const perRow = 3;
  return {
    key: `v-${v.id}`,
    kind: "image",
    versionId: v.id,
    imageUrl: v.imageUrl,
    naturalW: v.width,
    naturalH: v.height,
    x: (idx % perRow) * (baseW + 48),
    y: Math.floor(idx / perRow) * (baseH + 64),
    w: baseW,
    h: baseH,
  };
}

type Gesture =
  | { type: "pan"; sx: number; sy: number; cam: { x: number; y: number } }
  | {
      type: "marquee";
      sx: number;
      sy: number;
      additive: boolean;
    }
  | {
      type: "move";
      sx: number;
      sy: number;
      start: Map<string, { x: number; y: number }>;
      /** 本次手势按下的 item key —— 抬起且未拖动时视为「真实点击」该 item。 */
      tapKey?: string;
    }
  | {
      type: "resize";
      sx: number;
      sy: number;
      key: string;
      corner: "nw" | "ne" | "sw" | "se";
      base: { x: number; y: number; w: number; h: number };
      ratio: number; // >0 = lock aspect
    }
  | null;

export type CanvasEditBridge = {
  ops: { value: string; label: string; mask?: boolean }[];
  busy: boolean;
  instr: string;
  onInstrChange: (v: string) => void;
  onRun: (version: GenerationVersion, op: string) => void;
  onOpenMask: (version: GenerationVersion) => void;
  /** V0.0.13e — 终选/交付/审阅（BrandAI 特有业务，视觉创作无此概念）：
   *  下方独立面板已删，动作挪进画布选中工具条（跟随画布选中，交互形态与
   *  视觉创作的「选中即操作」一致）。 */
  delivery?: {
    isFinal: boolean;
    hasFinal: boolean;
    busy: string | null;
    error?: string | null;
    onMarkFinal: () => void;
    onExport: () => void;
    reviewStatus?: string | null;
    canSubmitReview: boolean;
    canDecideReview: boolean;
    reviewBusy: boolean;
    onSubmitReview: () => void;
    onApprove: () => void;
    onOpenReject: () => void;
  };
};

export function OpenCanvas({
  seedVersions,
  seedReady = false,
  running,
  status,
  timedOut,
  error,
  onSelectVersion,
  activeVersionId,
  selectNonce,
  fitKey,
  onUploadImage,
  onUserPickImage,
  onBlankClick,
  chatRefStates,
  persist,
  uploadFilesRef,
  edit,
}: {
  seedVersions: GenerationVersion[];
  /** 当前 Campaign 的历史查询是否已成功加载。seed 成员剪枝只在 true 时执行——
   *  切 Campaign 后新 key 的 history 尚未返回时 seed 短暂为空/不全，此时剪枝会
   *  把水合恢复的本项目版本 tile 误删（丢自定义布局）。 */
  seedReady?: boolean;
  running: boolean;
  status: string | null;
  timedOut: boolean;
  error?: string;
  /** 单选某张出图变体时回传 versionId(null=未选),让右下表单/终选条同步 activeVariant。 */
  onSelectVersion: (versionId: string | null) => void;
  /** 外部「当前变体」(变体缩略图/终选条)—— 变化时把画布选择同步过来,保证画布改图
   *  工具条(soloVersion)与终选/导出/审阅(activeVariant)永远指向同一版本。 */
  activeVersionId?: string | null;
  /** 点变体缩略图的显式信号:每次 +1 都强制把 activeVersionId 的 tile 重新选中 ——
   *  即便 activeVersionId 未变(点的是已选变体),也能从「清选」态一键回到选中。 */
  selectNonce?: number;
  /** 触发「自动适配」的 key(= 当前 generation id):变化=切了 generation,重新适配一次
   *  取景;同一 generation 内新增改图子版本不重置(不夺走用户手动缩放/平移)。 */
  fitKey?: string;
  /** 上传图片到画布:返回公网 URL + 真实尺寸 + 资产 id（可持久引用/对话引用）。 */
  onUploadImage: (file: File) => Promise<{
    url: string;
    width?: number;
    height?: number;
    assetId?: string;
  }>;
  /** 用户「真实点击」某图片 item（出图变体或上传/素材图；非拖拽、非程序化选择同步）
   *  时回传。与 onSelectVersion 分离：后者由选择同步 effect 驱动、会因回调身份变化
   *  重放，不能承载「点选插入引用」这类一次性用户意图（V0.0.13c/13d 对话点选取图）。
   *  additive = Shift/Ctrl/Cmd 点选（prd_agent 累加语义）。 */
  onUserPickImage?: (
    pick: { versionId?: string; assetId?: string; imageUrl: string },
    opts: { additive: boolean },
  ) => void;
  /** 点画布空白（非框选、非 shift）清空选择时回传 —— 页面据此清对话灰待选 chip
   *  （prd_agent clearSelectionWithChips 语义）。 */
  onBlankClick?: () => void;
  /** 对话引用态（versionId/assetId → 序号+就绪）：画布图片本体叠加
   *  灰罩✓（待选）/ 序号角标（已确认），与变体条/历史条一致（prd_agent 同款）。 */
  chatRefStates?: Record<string, { ordinal: number; ready: boolean }>;
  /** 服务端持久化作用域（V0.0.13d）：挂载即 GET 恢复（手动元素/相机/已删版本集），
   *  变化后 1200ms 防抖 PUT。出图变体 tile 由 seedVersions 服务端权威重建，不入画布 JSON。 */
  persist?: { wsId: string; projectId: string };
  /** 页面侧（如 composer 粘贴图片）注入文件上传到画布的入口。 */
  uploadFilesRef?: MutableRefObject<((files: File[]) => void) | null>;
  edit: CanvasEditBridge;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const editTextRef = useRef<HTMLTextAreaElement>(null);
  const gestureRef = useRef<Gesture>(null);
  const movedRef = useRef(false);
  // 手动双击检测:item 在容器上 setPointerCapture 后,原生 dblclick 会被重定向到
  // 容器、item 的 onDoubleClick 永不触发(文字双击进编辑因此失效)。改用计时检测。
  const lastTapRef = useRef<{ key: string; t: number }>({ key: "", t: 0 });

  const [items, setItems] = useState<CanvasItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(1);
  const [camera, setCamera] = useState({ x: 120, y: 80 });
  const [tool, setTool] = useState<"select" | "hand">("select");
  const [placing, setPlacing] = useState<null | {
    kind: CanvasItemKind;
    shapeType?: ShapeType;
  }>(null);
  const [marquee, setMarquee] = useState<null | {
    x: number;
    y: number;
    w: number;
    h: number;
  }>(null);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [space, setSpace] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // 选中出图变体后「待执行的改图操作」(arm)。点 op chip 只是选中操作(不立即发图),
  // 输入指令后回车/点「出图」才真正改图——避免「点一下就锁死整条工具条」。
  const [armedOp, setArmedOp] = useState<string | null>(null);

  const commitTextEdit = useCallback((key: string, value: string) => {
    setItems((prev) =>
      prev.map((p) => (p.key === key ? { ...p, text: value } : p)),
    );
    setEditingText(null);
  }, []);

  // 最新 viewport 放 ref,wheel 监听只绑一次。
  const vpRef = useRef({ zoom, camera });
  vpRef.current = { zoom, camera };

  // 用户从画布删掉的出图变体 tile —— 记住其 versionId,防止下面的 seedVersions 合并
  // 在轮询刷新/新子版本到达时把它当「缺失版本」再加回来(Delete 白删)(Bugbot Medium)。
  // V0.0.13d：随画布持久化（否则刷新后已删 tile 复活）；变化经 bumpRemovedNonce 触发保存。
  const removedVersionIdsRef = useRef<Set<string>>(new Set());
  const [removedNonce, setRemovedNonce] = useState(0);
  const bumpRemovedNonce = () => setRemovedNonce((n) => n + 1);

  /* ---------- V0.0.13d · 服务端持久化（对齐 prd_agent image_master_canvases） ----------
   * 只持久化「手动元素」（上传图/素材图/形状/文字，无 versionId）+ 相机 + 已删版本集。
   * 出图变体 tile 由 seedVersions（Generation 服务端数据）权威重建，不入画布 JSON——
   * 这也是 F19 ⑨ 用户定夺的「画布=持久开放世界工作台，变体 tile 随出图进出」语义。 */
  const [hydrated, setHydrated] = useState(!persist);
  const suppressNextFitRef = useRef(false);
  const lastSavedRef = useRef("");
  const persistWs = persist?.wsId;
  const persistProject = persist?.projectId;
  useEffect(() => {
    if (!persistWs || !persistProject) {
      setHydrated(true);
      return;
    }
    let cancelled = false;
    setHydrated(false);
    // 切 Campaign（Codex P2）：先清掉上一项目残留在内存的 items——否则下方
    // 恢复合并的 extra 过滤会把 A 项目的版本 tile 保进 B 的画布，且随后的
    // 自动保存会把它们持久化进 B 的 ProjectCanvas（route 归属校验只到
    // workspace 级，拦不住同空间跨项目）。旧项目的待保存已由作用域 flush
    // effect 在本效果重跑前发出；seed 合并只在 seedVersions 身份变化时重跑，
    // 清空后不会用旧 generation 的 versions 把它们加回来。
    setItems([]);
    removedVersionIdsRef.current = new Set();
    lastSavedRef.current = "";
    (async () => {
      let restored = false;
      try {
        const res = await fetch(
          `/api/workspaces/${persistWs}/projects/${persistProject}/canvas`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          items?: CanvasItem[];
          camera?: { x: number; y: number; zoom: number };
          removedVersionIds?: string[];
        };
        if (cancelled) return;
        // V0.0.13e：版本 tile 一并恢复（画布累积语义）；仅剔除被删集合命中的。
        const removedSet = new Set(data.removedVersionIds ?? []);
        const manual = (data.items ?? []).filter(
          (it) => it.key && !(it.versionId && removedSet.has(it.versionId)),
        );
        // uid 计数器回填：模块计数器刷新归零，恢复旧 key 后新建项可能撞 key。
        for (const it of manual) {
          const m = /-(\d+)-/.exec(it.key);
          if (m && Number(m[1]) >= __k) __k = Number(m[1]) + 1;
        }
        removedVersionIdsRef.current = new Set(data.removedVersionIds ?? []);
        setItems((prev) => {
          // 服务端为准；seed 合并可能已抢先加了当前 gen 的 tile —— 按
          // versionId/key 去重后保留（避免同一版本双 tile）。
          const haveVer = new Set(
            manual.filter((it) => it.versionId).map((it) => it.versionId),
          );
          const haveKey = new Set(manual.map((it) => it.key));
          const extra = prev.filter(
            (it) =>
              it.versionId &&
              !removedVersionIdsRef.current.has(it.versionId) &&
              !haveVer.has(it.versionId) &&
              !haveKey.has(it.key),
          );
          return [...manual, ...extra];
        });
        if (
          data.camera &&
          Number.isFinite(data.camera.zoom) &&
          data.camera.zoom > 0
        ) {
          setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, data.camera.zoom)));
          setCamera({ x: data.camera.x, y: data.camera.y });
          // 恢复了取景 → 跳过下一次 fitKey 自动适配（否则覆盖恢复的视角）。
          suppressNextFitRef.current = true;
        }
        // 恢复即基线：刚加载完不要立刻触发一次无意义保存。
        lastSavedRef.current = JSON.stringify({
          items: manual,
          camera: data.camera ?? null,
          removedVersionIds: [...removedVersionIdsRef.current].sort(),
        });
        restored = true;
      } catch {
        /* 读取异常 → 走下方 finally 的「未恢复不放开保存」路径 */
      } finally {
        // 只有成功恢复才放开自动保存（Codex P2）：读取失败（瞬时非 200 /
        // 网络异常）时 items 已被上方作用域清空，若照旧置 hydrated，自动
        // 保存会把空画布 PUT 覆盖服务端已存状态。代价是失败这次会话的
        // 编辑不入库（画布仍可用，刷新即重试恢复+恢复保存），比静默清库安全。
        // 真空画布不受影响：route 无记录时返回 200 空态，restored 照常为真。
        if (!cancelled && restored) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persistWs, persistProject]);

  // 1200ms 防抖保存（prd_agent autosave 同款节奏）；内容未变不发；失败下次重试。
  useEffect(() => {
    if (!persistWs || !persistProject || !hydrated) return;
    const eligible = items.filter(
      (it) =>
        !(
          it.kind === "image" &&
          (!it.imageUrl ||
            it.imageUrl.startsWith("data:") ||
            it.imageUrl.startsWith("blob:"))
        ),
    );
    // 200 上限的预算先给手工元素（上传/形状/文字/素材 tile），再给播种的
    // 版本 tile（Codex P2）：全量播种可能把 200 个版本 tile 排在数组前部，
    // 若从头截断，之后新增的手工元素永远进不了 PUT——本地可见、刷新即丢。
    // 版本 tile 即使被挤出持久化，恢复时也会由播种流程重新铺上（仅丢布局）。
    const keepKeys = new Set<string>();
    let budget = 200;
    for (const it of eligible) {
      if (budget <= 0) break;
      if (!(it.kind === "image" && it.versionId)) {
        keepKeys.add(it.key);
        budget--;
      }
    }
    for (const it of eligible) {
      if (budget <= 0) break;
      if (it.kind === "image" && it.versionId && !keepKeys.has(it.key)) {
        keepKeys.add(it.key);
        budget--;
      }
    }
    const manual = eligible
      .filter((it) => keepKeys.has(it.key))
      .map((it) =>
        it.kind === "image"
          ? {
              key: it.key,
              kind: it.kind,
              x: it.x,
              y: it.y,
              w: it.w,
              h: it.h,
              imageUrl: it.imageUrl!,
              ...(it.versionId ? { versionId: it.versionId } : {}),
              ...(it.assetId ? { assetId: it.assetId } : {}),
              ...(it.naturalW ? { naturalW: it.naturalW } : {}),
              ...(it.naturalH ? { naturalH: it.naturalH } : {}),
            }
          : it.kind === "shape"
            ? {
                key: it.key,
                kind: it.kind,
                x: it.x,
                y: it.y,
                w: it.w,
                h: it.h,
                shapeType: it.shapeType ?? "rect",
                fill: it.fill ?? "",
                stroke: it.stroke ?? "",
              }
            : {
                key: it.key,
                kind: it.kind,
                x: it.x,
                y: it.y,
                w: it.w,
                h: it.h,
                text: it.text ?? "",
                fontSize: it.fontSize ?? 18,
                color: it.color ?? "",
              },
      );
    const body = {
      items: manual,
      camera: { x: camera.x, y: camera.y, zoom },
      removedVersionIds: [...removedVersionIdsRef.current].sort(),
    };
    const json = JSON.stringify(body);
    // 基线比对时忽略 camera 精度抖动之外的等值（简单字符串比对足够：内容一致即跳过）。
    if (json === lastSavedRef.current) return;
    // keepalive 只用于离页 flush（浏览器对 keepalive 请求体有 ~64KB 上限，
    // 大画布常态自动保存若带 keepalive 会在客户端直接 reject、保存静默失效
    // —— Codex P2）。常态防抖走普通 fetch；刷新/关页时才用 keepalive 让
    // 在途 PUT 于页面卸载后仍能送达（防 last-writer-wins 丢更新，灰度实测踩中）。
    const put = (useKeepalive: boolean) => {
      lastSavedRef.current = json;
      pendingSaveRef.current = null;
      // 失败自愈（Codex P2）：防抖 effect 只在内容变化时重跑——瞬时 500/网络
      // 抖动后用户不再编辑或直接刷新，最后一次编辑就永远丢了（pending 已在
      // 发送前清空，离页 flush 也无从重发）。失败时恢复 pending（离页/切项目
      // flush 可重发）+ 4s 定时重试；若期间有更新的保存接管（pending 被新
      // 闭包覆盖）则放弃，避免旧 JSON 迟到覆盖新状态（last-writer-wins）。
      const onFail = () => {
        lastSavedRef.current = "";
        if (pendingSaveRef.current === null) {
          pendingSaveRef.current = put;
          window.setTimeout(() => {
            if (pendingSaveRef.current === put) put(false);
          }, 4000);
        }
      };
      void fetch(
        `/api/workspaces/${persistWs}/projects/${persistProject}/canvas`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: json,
          ...(useKeepalive ? { keepalive: true } : {}),
        },
      ).then(
        (r) => {
          if (!r.ok) onFail();
        },
        () => {
          onFail();
        },
      );
    };
    pendingSaveRef.current = put;
    const t = window.setTimeout(() => put(false), 1200);
    return () => window.clearTimeout(t);
  }, [items, camera, zoom, removedNonce, hydrated, persistWs, persistProject]);

  // 离页 flush：防抖计时器尚未触发就刷新/关页 → 立即把待保存状态发出去
  //（fetch keepalive 允许请求在页面卸载后完成）。
  const pendingSaveRef = useRef<((useKeepalive: boolean) => void) | null>(null);
  useEffect(() => {
    const flush = () => {
      pendingSaveRef.current?.(true);
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, []);

  // 切项目/卸载 flush（Codex P2）：SPA 内切 Campaign 不触发 pagehide，若仍在
  // 1.2s 防抖窗口内，旧项目的最后编辑会随 clearTimeout 一起丢。此 effect 只随
  // 持久化作用域变化清理——pending 闭包捕获的是旧作用域的 URL 与 JSON，此刻
  // 直接发出（页面未卸载，普通 fetch 即可），不会写进新项目。
  useEffect(() => {
    return () => {
      pendingSaveRef.current?.(false);
      pendingSaveRef.current = null;
    };
  }, [persistWs, persistProject]);

  // 出图变体 → 画布图片 item:增量合并(保留手工布局/形状/文字;切 generation 时
  // 移除已不在的版本;改图新子版本自动作为新 item 浮现)。
  useEffect(() => {
    setItems((prev) => {
      const byId = new Map(seedVersions.map((v) => [v.id, v]));
      // V0.0.13e：不再按「当前 generation」裁剪版本 tile —— 出图跨 generation
      // 累积在画布上（对齐 prd_agent 单画布），只有用户显式删除（removedVersionIds）
      // 才移除；下方变体/历史条已删，画布是唯一图片表面。
      const kept = prev
        .filter(
          (it) =>
            !it.versionId || !removedVersionIdsRef.current.has(it.versionId),
        )
        // seed 成员剪枝（Codex P2）：seed = 本 Campaign 全部 generation 的版本
        // 并集（page.tsx 已做项目一致性闸）。不在其中的版本 tile 要么是切
        // Campaign 过渡帧里混进来的他项目 tile，要么是已被服务端删除
        // （regenerate dropStaleRoots）的死 tile——留着会渲染出点选即报错的
        // 幽灵图。仅在 seedReady（新 key 的 history 已加载）时剪，避免把
        // 水合恢复的本项目 tile 在 seed 就位前误删。
        .filter(
          (it) => !it.versionId || !seedReady || byId.has(it.versionId),
        )
        .map((it) => {
          // 版本 id 不变但 imageUrl/尺寸后续可能被轮询更新(如占位→真图) → 同步到
          // 已存在的画布 tile,否则会停在旧值/空白(Bugbot)。只同步图源与自然尺寸,
          // 保留用户手工的位置/显示大小(x/y/w/h)。
          if (!it.versionId) return it;
          const v = byId.get(it.versionId);
          if (
            !v ||
            (v.imageUrl === it.imageUrl &&
              v.width === it.naturalW &&
              v.height === it.naturalH)
          )
            return it;
          return {
            ...it,
            imageUrl: v.imageUrl,
            naturalW: v.width,
            naturalH: v.height,
          };
        });
      const have = new Set(
        kept.filter((it) => it.versionId).map((it) => it.versionId),
      );
      const fresh = seedVersions.filter(
        (v) => !have.has(v.id) && !removedVersionIdsRef.current.has(v.id),
      );
      if (fresh.length === 0) return kept;
      // 新 tile 落在现有内容包围盒下方（避免与累积的旧图/手动元素重叠）。
      // 4 列换行：历史 generation 全量回填（老项目首次进入）可能一次落几十张，
      // 单行会拉出超长横条。
      const maxY = kept.length
        ? Math.max(...kept.map((it) => it.y + it.h))
        : -64;
      const COLS = 4;
      let rowY = maxY + 64;
      let colX = 0;
      let rowH = 0;
      const add = fresh.map((v, i) => {
        const item = imageItemFromVersion(v, i);
        if (i > 0 && i % COLS === 0) {
          rowY += rowH + 48;
          colX = 0;
          rowH = 0;
        }
        const placed = { ...item, x: colX, y: rowY };
        colX += item.w + 48;
        rowH = Math.max(rowH, item.h);
        return placed;
      });
      return [...kept, ...add];
    });
  }, [seedVersions, seedReady]);

  // items 变化后(尤其切 generation 时版本 tile 被裁剪)把 selected 收敛到仍存在的 key ——
  // 否则被移除版本的 key 残留在 selected 里,图层/删除条仍高亮可点、键盘操作打到「幽灵
  // 选择」(Bugbot Medium)。手动加的上传图/形状/文字 key 仍在 items 中,其选择不受影响。
  useEffect(() => {
    setSelected((sel) => {
      if (sel.size === 0) return sel;
      const keys = new Set(items.map((it) => it.key));
      let changed = false;
      const next = new Set<string>();
      for (const k of sel) {
        if (keys.has(k)) next.add(k);
        else changed = true;
      }
      return changed ? next : sel;
    });
  }, [items]);

  const versionById = useMemo(() => {
    const m = new Map<string, GenerationVersion>();
    for (const v of seedVersions) m.set(v.id, v);
    return m;
  }, [seedVersions]);

  // 单选出图变体 → 同步 activeVariant + 提供操作条目标。
  const selectedKeys = useMemo(() => [...selected], [selected]);
  const soloVersion = useMemo(() => {
    if (selectedKeys.length !== 1) return null;
    const it = items.find((i) => i.key === selectedKeys[0]);
    if (it?.versionId) return versionById.get(it.versionId) ?? null;
    return null;
  }, [selectedKeys, items, versionById]);
  useEffect(() => {
    onSelectVersion(soloVersion?.id ?? null);
  }, [soloVersion, onSelectVersion]);
  // 换选/取消选中 → 清掉待执行操作(避免把上一张的 armed op 带到下一张)。
  useEffect(() => {
    setArmedOp(null);
  }, [soloVersion?.id]);

  // 外部当前变体(缩略图条默认高亮第 0 张 / 点缩略图 / 终选条切版本) → 同步画布选择,
  // 消除「缩略图选 B、画布仍选 A → 改图打 A、终选/导出打 B」的分叉(Bugbot High)。
  // 用 ref 记「已对哪个 activeVersionId 应用过」,避免 items 变化(拖拽/新子版本)时反复
  // 覆盖用户对形状/文字的选择——只在 activeVersionId 真的变、或它的 tile 刚挂载时应用一次。
  const appliedActiveVerRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (activeVersionId == null) return;
    if (appliedActiveVerRef.current === activeVersionId) return;
    const it = items.find((i) => i.versionId === activeVersionId);
    if (it) {
      // 命中 tile → 选中它。首屏 seedVersions 合并后 tile 一挂载即在此选中当前变体(缩略图
      // 条本就默认高亮它),不再出现「缩略图高亮却画布空选、浮动改图条不出」的死锁(Bugbot Med)。
      appliedActiveVerRef.current = activeVersionId;
      setSelected((prev) =>
        prev.size === 1 && prev.has(it.key) ? prev : new Set([it.key]),
      );
      return;
    }
    // 无匹配 tile。区分两种:①该版本被用户从画布删了(removedVersionIdsRef 命中) →
    // 清掉画布上残留的「其它版本 tile」选择,避免缩略图选已删版本、画布仍选旧版本 tile
    // 的分叉(Bugbot High);手动加的形状/文字选择不动(它们无 versionId,不构成版本分叉)。
    // ②只是首屏 tile 还没挂载 → 不动、不推进 ref,等 tile 出现再在上面命中选中。
    if (removedVersionIdsRef.current.has(activeVersionId)) {
      appliedActiveVerRef.current = activeVersionId;
      setSelected((prev) => {
        const hasVersionTile = [...prev].some(
          (k) => items.find((i) => i.key === k)?.versionId != null,
        );
        return hasVersionTile ? new Set<string>() : prev;
      });
    }
  }, [activeVersionId, items]);
  // 点变体缩略图的显式重选:每次 selectNonce +1(用户点了缩略图)都把 activeVersionId 的
  // tile 重新选中——即便 activeVersionId 未变(点的是已选变体、上面 ref 守卫会跳过),也能
  // 从「点空白清选」态一键回到条↔画布同步,消除「清选后点缩略图无反应」死锁(Bugbot Med)。
  useEffect(() => {
    if (!selectNonce) return; // 初值 0(未点过)不触发,保留入场默认行为
    if (activeVersionId == null) return;
    const it = items.find((i) => i.versionId === activeVersionId);
    if (!it) return;
    appliedActiveVerRef.current = activeVersionId;
    setSelected((prev) =>
      prev.size === 1 && prev.has(it.key) ? prev : new Set([it.key]),
    );
    // 仅由缩略图点击信号驱动;不把 items/activeVersionId 放 deps,避免它们变化时误重选。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectNonce]);

  // 文字编辑「点击空白处提交」—— 点画布(普通 div,不可聚焦)不会让 textarea 失焦,
  // 于是 onBlur 不触发、编辑永远提交不掉(用户点别处文字也不会改)。这里在编辑期
  // 监听全局 pointerdown:只要按在 textarea 之外,就主动 blur 它 → 触发 onBlur 提交。
  useEffect(() => {
    if (!editingText) return;
    // 延后一帧聚焦:进编辑由 pointerdown 触发,若用 autoFocus 同步聚焦,正在进行的
    // click 焦点结算会立刻把 textarea blur 掉 → onBlur 立即把 editingText 清空、编辑
    // 框一闪而过。等当前事件结算完(下一 tick)再聚焦,就稳了。
    const focusTimer = setTimeout(() => editTextRef.current?.focus(), 0);
    // 点 textarea 之外的任意处 → 主动 blur 提交(点普通 div 不会自动失焦)。
    const onDocDown = (e: PointerEvent) => {
      const ta = editTextRef.current;
      if (ta && e.target !== ta) commitTextEdit(editingText, ta.value);
    };
    document.addEventListener("pointerdown", onDocDown, true);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener("pointerdown", onDocDown, true);
    };
  }, [commitTextEdit, editingText]);

  // ---- 坐标转换 ----
  const toWorld = useCallback(
    (sx: number, sy: number) => {
      const { zoom: z, camera: c } = vpRef.current;
      return { x: (sx - c.x) / z, y: (sy - c.y) / z };
    },
    [],
  );
  const localPoint = (e: { clientX: number; clientY: number }) => {
    const r = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // ---- 缩放(光标定点)/适配 ----
  const zoomAt = useCallback((sx: number, sy: number, nextZoom: number) => {
    const { zoom: z, camera: c } = vpRef.current;
    const z2 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextZoom));
    if (z2 === z) return;
    const wx = (sx - c.x) / z;
    const wy = (sy - c.y) / z;
    setZoom(z2);
    setCamera({ x: sx - wx * z2, y: sy - wy * z2 });
  }, []);

  const centerScreen = () => {
    const r = containerRef.current?.getBoundingClientRect();
    return { x: (r?.width ?? 800) / 2, y: (r?.height ?? 600) / 2 };
  };
  const zoomByButton = (factor: number) => {
    const c = centerScreen();
    zoomAt(c.x, c.y, vpRef.current.zoom * factor);
  };
  const fitToContent = useCallback(() => {
    const r = containerRef.current?.getBoundingClientRect();
    if (!r) return;
    if (items.length === 0) {
      setZoom(1);
      setCamera({ x: r.width / 2, y: r.height / 2 });
      return;
    }
    const minX = Math.min(...items.map((i) => i.x));
    const minY = Math.min(...items.map((i) => i.y));
    const maxX = Math.max(...items.map((i) => i.x + i.w));
    const maxY = Math.max(...items.map((i) => i.y + i.h));
    const bw = maxX - minX || 1;
    const bh = maxY - minY || 1;
    const pad = 80;
    const z = Math.min(
      ZOOM_MAX,
      Math.max(ZOOM_MIN, Math.min((r.width - pad) / bw, (r.height - pad) / bh, 1)),
    );
    setZoom(z);
    setCamera({
      x: r.width / 2 - ((minX + maxX) / 2) * z,
      y: r.height / 2 - ((minY + maxY) / 2) * z,
    });
  }, [items]);

  // 自动适配取景:首批 item 落地时、以及每次切 generation(fitKey 变)后各适配一次。
  // 用 lastFitKeyRef 记录「上次已适配的 fitKey」——切 generation 会换一批变体 tile,若不
  // 重适配,新出图可能落在视口外要手动点「适配」(Bugbot Low);而同一 generation 内新增
  // 改图子版本 fitKey 不变 → 不重适配,不夺走用户已调好的缩放/平移。
  const lastFitKeyRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (items.length === 0) return;
    if (lastFitKeyRef.current === fitKey) return;
    lastFitKeyRef.current = fitKey;
    // 持久化恢复了相机取景 → 跳过这一次自动适配（V0.0.13d）。
    if (suppressNextFitRef.current) {
      suppressNextFitRef.current = false;
      return;
    }
    fitToContent();
  }, [items, fitKey, fitToContent]);

  // ---- wheel 手势(passive:false,只绑一次) ----
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      const r = el.getBoundingClientRect();
      const sx = ev.clientX - r.left;
      const sy = ev.clientY - r.top;
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        zoomAt(sx, sy, vpRef.current.zoom * Math.exp(-ev.deltaY * 0.003));
      } else {
        ev.preventDefault();
        const c = vpRef.current.camera;
        setCamera({ x: c.x - ev.deltaX, y: c.y - ev.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // ---- 键盘:空格临时手型、删除、Esc、方向键微移 ----
  useEffect(() => {
    const isTyping = () => {
      const a = document.activeElement;
      return (
        a instanceof HTMLInputElement ||
        a instanceof HTMLTextAreaElement ||
        (a as HTMLElement | null)?.isContentEditable
      );
    };
    const down = (e: KeyboardEvent) => {
      if (isTyping()) return;
      if (e.code === "Space") {
        e.preventDefault();
        setSpace(true);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selected.size) {
          e.preventDefault();
          setItems((p) => {
            for (const it of p)
              if (selected.has(it.key) && it.versionId)
                removedVersionIdsRef.current.add(it.versionId);
            return p.filter((it) => !selected.has(it.key));
          });
          bumpRemovedNonce();
          setSelected(new Set());
        }
      } else if (e.key === "Escape") {
        setSelected(new Set());
        setPlacing(null);
        setEditingText(null);
      } else if (e.key.startsWith("Arrow") && selected.size) {
        e.preventDefault();
        const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key]!;
        const step = e.shiftKey ? 10 : 1;
        setItems((p) =>
          p.map((it) =>
            selected.has(it.key)
              ? { ...it, x: it.x + d[0]! * step, y: it.y + d[1]! * step }
              : it,
          ),
        );
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpace(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [selected]);

  // ---- 图层 ----
  const reorder = (mode: "front" | "back" | "up" | "down") => {
    setItems((prev) => {
      if (!selected.size) return prev;
      const sel = prev.filter((i) => selected.has(i.key));
      const rest = prev.filter((i) => !selected.has(i.key));
      if (mode === "front") return [...rest, ...sel];
      if (mode === "back") return [...sel, ...rest];
      const out = [...prev];
      if (mode === "up") {
        for (let i = out.length - 2; i >= 0; i--)
          if (selected.has(out[i]!.key) && !selected.has(out[i + 1]!.key))
            [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
      } else {
        for (let i = 1; i < out.length; i++)
          if (selected.has(out[i]!.key) && !selected.has(out[i - 1]!.key))
            [out[i - 1], out[i]] = [out[i]!, out[i - 1]!];
      }
      return out;
    });
  };

  // ---- 放置新元素 / 上传 ----
  const place = useCallback(
    (sx: number, sy: number) => {
      const p = placing;
      if (!p) return;
      const w = p.kind === "text" ? 320 : 200;
      const h = p.kind === "text" ? 88 : 160;
      const wp = toWorld(sx, sy);
      const item: CanvasItem =
        p.kind === "shape"
          ? {
              key: uid("shape"),
              kind: "shape",
              shapeType: p.shapeType ?? "rect",
              x: wp.x - w / 2,
              y: wp.y - h / 2,
              w,
              h,
              fill: VIOLET,
              stroke: "rgb(91 63 224)",
            }
          : {
              key: uid("text"),
              kind: "text",
              x: wp.x - w / 2,
              y: wp.y - h / 2,
              w,
              h,
              text: "双击编辑文字",
              fontSize: 22,
              color: "rgb(31 31 42)",
            };
      setItems((prev) => [...prev, item]);
      setSelected(new Set([item.key]));
      setPlacing(null);
    },
    [placing, toWorld],
  );

  const triggerUpload = () => fileRef.current?.click();

  /**
   * 统一上传入口（prd_agent onUploadImages 的移植）：按钮 / 拖拽文件 / 画布粘贴 /
   * composer 粘贴全部汇入。逐张串行上传 → 视口指定点（缺省中心）放置 →
   * 最新一张自动单选 + 上报点选（对话面板插灰待选 chip，Tab:5184-5191 同款）。
   */
  const uploadFiles = useCallback(
    async (files: File[], at?: { sx: number; sy: number }) => {
      const imgs = files.filter((f) => f.type.startsWith("image/")).slice(0, 20);
      if (imgs.length === 0) return;
      setUploadError(null);
      // V0.0.13h — 先本地预览秒上画布，再后台持久化（prd_agent 同款体感）：
      // FileReader dataURL 立即建 tile（syncStatus:pending，角标「同步中」），
      // 上传成功后回填 assetId + 代理 URL（syncStatus 清除→参与持久化），
      // 失败标 failed（红色「未持久化」，刷新会丢）。
      const readAsDataUrl = (f: File) =>
        new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(new Error("读取文件失败"));
          r.readAsDataURL(f);
        });
      const probeSize = (src: string) =>
        new Promise<{ w: number; h: number }>((resolve) => {
          const im = new Image();
          im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight });
          im.onerror = () => resolve({ w: 0, h: 0 });
          im.src = src;
        });
      let lastKey: string | null = null;
      const uploads: Promise<void>[] = [];
      for (let i = 0; i < imgs.length; i++) {
        const f = imgs[i]!;
        let dataUrl: string;
        try {
          dataUrl = await readAsDataUrl(f);
        } catch (err) {
          setUploadError(err instanceof Error ? err.message : "读取失败");
          continue;
        }
        const nat = await probeSize(dataUrl);
        const ratio = nat.w && nat.h ? nat.w / nat.h : 1;
        const w = 280;
        const h = Math.round(w / (ratio || 1));
        const c = at ? { x: at.sx, y: at.sy } : centerScreen();
        const wp = toWorld(c.x, c.y);
        const key = uid("img");
        lastKey = key;
        const item: CanvasItem = {
          key,
          kind: "image",
          imageUrl: dataUrl,
          naturalW: nat.w || undefined,
          naturalH: nat.h || undefined,
          x: wp.x - w / 2 + i * 24,
          y: wp.y - h / 2 + i * 24,
          w,
          h,
          syncStatus: "pending",
        };
        setItems((prev) => [...prev, item]);
        // 后台上传（不阻塞下一张的本地预览）。
        uploads.push(
          onUploadImage(f).then(
            ({ url, width, height, assetId }) => {
              setItems((prev) =>
                prev.map((p) =>
                  p.key === key
                    ? {
                        ...p,
                        imageUrl: url,
                        assetId,
                        naturalW: width ?? p.naturalW,
                        naturalH: height ?? p.naturalH,
                        syncStatus: "synced",
                      }
                    : p,
                ),
              );
              // 上传完成即预选：自动插灰待选 chip（需要 assetId 才能被引用）。
              if (key === lastKey && assetId) {
                onUserPickImage?.(
                  { assetId, imageUrl: url },
                  { additive: false },
                );
              }
            },
            (err) => {
              setItems((prev) =>
                prev.map((p) =>
                  p.key === key ? { ...p, syncStatus: "failed" } : p,
                ),
              );
              setUploadError(
                err instanceof Error ? err.message : "上传失败（图片未持久化，刷新会丢）",
              );
            },
          ),
        );
      }
      if (lastKey) setSelected(new Set([lastKey]));
      await Promise.allSettled(uploads);
    },
    [onUploadImage, onUserPickImage, toWorld],
  );

  // 页面注入口（composer 粘贴图片 → 上传进画布）。
  useEffect(() => {
    if (!uploadFilesRef) return;
    uploadFilesRef.current = (files: File[]) => void uploadFiles(files);
    return () => {
      uploadFilesRef.current = null;
    };
  }, [uploadFilesRef, uploadFiles]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fs = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (fs.length) await uploadFiles(fs);
  };

  // 画布粘贴（prd_agent 途径3）：指针悬停在画布上时接管剪贴板图片；
  // 焦点在输入控件里不劫持（用户可能在 composer 粘贴文字/图片）。
  const stageHoverRef = useRef(false);
  useEffect(() => {
    const onPaste = (ev: ClipboardEvent) => {
      const t = ev.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable ||
          t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA")
      )
        return;
      if (!stageHoverRef.current) return;
      const files = Array.from(ev.clipboardData?.files ?? []).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (files.length === 0) return;
      ev.preventDefault();
      void uploadFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [uploadFiles]);

  // ---- 指针手势 ----
  const beginPan = (e: React.PointerEvent) => {
    containerRef.current?.setPointerCapture(e.pointerId);
    gestureRef.current = {
      type: "pan",
      sx: e.clientX,
      sy: e.clientY,
      cam: { ...vpRef.current.camera },
    };
  };

  const onStageDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (placing) {
      const lp = localPoint(e);
      place(lp.x, lp.y);
      return;
    }
    if (tool === "hand" || space) {
      beginPan(e);
      return;
    }
    // 空白处:框选
    containerRef.current?.setPointerCapture(e.pointerId);
    const lp = localPoint(e);
    gestureRef.current = {
      type: "marquee",
      sx: lp.x,
      sy: lp.y,
      additive: e.shiftKey,
    };
    movedRef.current = false;
    if (!e.shiftKey) setSelected(new Set());
  };

  const addImageAtScreenPoint = useCallback(
    (asset: DraggedAsset, sx: number, sy: number) => {
      if (!asset.url) return;
      const ratio = asset.width && asset.height ? asset.width / asset.height : 1;
      const w = 240;
      const h = Math.round(w / (ratio || 1));
      const wp = toWorld(sx, sy);
      const item: CanvasItem = {
        key: uid("asset"),
        kind: "image",
        imageUrl: asset.url,
        assetId: asset.id,
        naturalW: asset.width,
        naturalH: asset.height,
        x: wp.x - w / 2,
        y: wp.y - h / 2,
        w,
        h,
      };
      setItems((prev) => [...prev, item]);
      setSelected(new Set([item.key]));
      // 素材拖入即预选（与上传一致）：自动插灰待选 chip。
      onUserPickImage?.(
        { assetId: asset.id, imageUrl: asset.url },
        { additive: false },
      );
    },
    [toWorld, onUserPickImage],
  );

  const beginItemDrag = (e: React.PointerEvent, key: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (placing) {
      const lp = localPoint(e);
      place(lp.x, lp.y);
      return;
    }
    if (tool === "hand" || space) {
      beginPan(e);
      return;
    }
    // 文字 item:手动双击检测 → 进编辑(绕开被 pointer-capture 吞掉的原生 dblclick)。
    const tappedItem = items.find((i) => i.key === key);
    if (tappedItem?.kind === "text") {
      const prev = lastTapRef.current;
      if (prev.key === key && Date.now() - prev.t < 350) {
        lastTapRef.current = { key: "", t: 0 };
        setSelected(new Set([key]));
        setEditingText(key);
        return; // 进编辑,不开拖拽
      }
      lastTapRef.current = { key, t: Date.now() };
    }
    containerRef.current?.setPointerCapture(e.pointerId);
    let nextSel = selected;
    if (e.shiftKey) {
      nextSel = new Set(selected);
      nextSel.has(key) ? nextSel.delete(key) : nextSel.add(key);
      setSelected(nextSel);
    } else if (!selected.has(key)) {
      nextSel = new Set([key]);
      setSelected(nextSel);
    }
    const start = new Map<string, { x: number; y: number }>();
    for (const it of items)
      if (nextSel.has(it.key)) start.set(it.key, { x: it.x, y: it.y });
    gestureRef.current = {
      type: "move",
      sx: e.clientX,
      sy: e.clientY,
      start,
      tapKey: key,
    };
    movedRef.current = false;
  };

  const beginResize = (
    e: React.PointerEvent,
    it: CanvasItem,
    corner: "nw" | "ne" | "sw" | "se",
  ) => {
    e.stopPropagation();
    containerRef.current?.setPointerCapture(e.pointerId);
    const ratio =
      it.kind === "image"
        ? it.naturalW && it.naturalH
          ? it.naturalW / it.naturalH
          : it.w / it.h
        : 0;
    gestureRef.current = {
      type: "resize",
      sx: e.clientX,
      sy: e.clientY,
      key: it.key,
      corner,
      base: { x: it.x, y: it.y, w: it.w, h: it.h },
      ratio: e.shiftKey ? 0 : ratio,
    };
  };

  const onStageMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    if (g.type === "pan") {
      setCamera({ x: g.cam.x + (e.clientX - g.sx), y: g.cam.y + (e.clientY - g.sy) });
      return;
    }
    if (g.type === "marquee") {
      const lp = localPoint(e);
      movedRef.current = true;
      setMarquee({
        x: Math.min(g.sx, lp.x),
        y: Math.min(g.sy, lp.y),
        w: Math.abs(lp.x - g.sx),
        h: Math.abs(lp.y - g.sy),
      });
      return;
    }
    if (g.type === "move") {
      const z = vpRef.current.zoom;
      const dx = (e.clientX - g.sx) / z;
      const dy = (e.clientY - g.sy) / z;
      movedRef.current = true;
      setItems((prev) =>
        prev.map((it) => {
          const s = g.start.get(it.key);
          return s ? { ...it, x: s.x + dx, y: s.y + dy } : it;
        }),
      );
      return;
    }
    if (g.type === "resize") {
      const z = vpRef.current.zoom;
      const dx = (e.clientX - g.sx) / z;
      const dy = (e.clientY - g.sy) / z;
      let { x, y, w, h } = g.base;
      if (g.corner === "nw") {
        x = g.base.x + dx;
        y = g.base.y + dy;
        w = g.base.w - dx;
        h = g.base.h - dy;
      } else if (g.corner === "ne") {
        y = g.base.y + dy;
        w = g.base.w + dx;
        h = g.base.h - dy;
      } else if (g.corner === "sw") {
        x = g.base.x + dx;
        w = g.base.w - dx;
        h = g.base.h + dy;
      } else {
        w = g.base.w + dx;
        h = g.base.h + dy;
      }
      if (g.ratio > 0) {
        if (w / h > g.ratio) h = w / g.ratio;
        else w = h * g.ratio;
        // 维持对角锚点:左/上侧缩放时重算 x/y
        if (g.corner === "nw") {
          x = g.base.x + (g.base.w - w);
          y = g.base.y + (g.base.h - h);
        } else if (g.corner === "ne") {
          y = g.base.y + (g.base.h - h);
        } else if (g.corner === "sw") {
          x = g.base.x + (g.base.w - w);
        }
      }
      w = Math.max(MIN_SIZE, w);
      h = Math.max(MIN_SIZE, h);
      setItems((prev) =>
        prev.map((it) => (it.key === g.key ? { ...it, x, y, w, h } : it)),
      );
      return;
    }
  };

  const onStageUp = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    try {
      containerRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    if (!g) return;
    if (g.type === "marquee") {
      const m = marquee;
      setMarquee(null);
      if (m && (m.w > 4 || m.h > 4)) {
        const a = toWorld(m.x, m.y);
        const b = toWorld(m.x + m.w, m.y + m.h);
        const hit = items
          .filter(
            (it) =>
              !(
                b.x < it.x ||
                a.x > it.x + it.w ||
                b.y < it.y ||
                a.y > it.y + it.h
              ),
          )
          .map((it) => it.key);
        setSelected((prev) =>
          g.additive ? new Set([...prev, ...hit]) : new Set(hit),
        );
      } else if (!g.additive && !movedRef.current) {
        // 点空白 = 清选择 + 通知页面清对话灰待选（prd_agent clearSelectionWithChips）。
        setSelected(new Set());
        onBlankClick?.();
      }
    }
    // 「真实点击」图片 item（按下即抬起、未拖动）→ 上报用户点选（replace；
    // Shift/Ctrl/Cmd = additive 累加）。只在此处上报：程序化选择同步
    // （activeVersionId/selectNonce/回调身份变化）永不触发。
    if (g.type === "move" && !movedRef.current && g.tapKey && onUserPickImage) {
      const it = items.find((i) => i.key === g.tapKey);
      if (it?.kind === "image" && it.imageUrl && (it.versionId || it.assetId)) {
        onUserPickImage(
          {
            versionId: it.versionId,
            assetId: it.assetId,
            imageUrl: it.imageUrl,
          },
          { additive: e.shiftKey || e.metaKey || e.ctrlKey },
        );
      }
    }
  };

  // 工具切换时退出放置/手型语义。
  const pickTool = (t: "select" | "hand") => {
    setTool(t);
    setPlacing(null);
  };

  const handCursor = tool === "hand" || space;

  return (
    <div
      ref={containerRef}
      onPointerDown={onStageDown}
      onPointerMove={onStageMove}
      onPointerUp={onStageUp}
      onPointerCancel={onStageUp}
      onPointerEnter={() => {
        stageHoverRef.current = true;
      }}
      onPointerLeave={() => {
        stageHoverRef.current = false;
      }}
      onDragOver={(e) => {
        if (
          e.dataTransfer.types.includes("application/x-brandai-asset") ||
          e.dataTransfer.types.includes("Files")
        ) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => {
        const raw = e.dataTransfer.getData("application/x-brandai-asset");
        if (raw) {
          e.preventDefault();
          try {
            const asset = JSON.parse(raw) as DraggedAsset;
            const lp = localPoint(e);
            addImageAtScreenPoint(asset, lp.x, lp.y);
          } catch {
            setUploadError("素材拖入失败");
          }
          return;
        }
        // 拖拽本地文件进画布（prd_agent 途径2）：落点处上传放置。
        const files = Array.from(e.dataTransfer.files ?? []).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (files.length > 0) {
          e.preventDefault();
          const lp = localPoint(e);
          void uploadFiles(files, { sx: lp.x, sy: lp.y });
        }
      }}
      className="relative min-h-[560px] flex-1 select-none overflow-hidden rounded-[28px] border border-border bg-card"
      style={{
        backgroundImage:
          "radial-gradient(circle at 1px 1px, rgba(124,92,255,0.12) 1px, transparent 0)",
        backgroundSize: `${18 * zoom}px ${18 * zoom}px`,
        backgroundPosition: `${camera.x}px ${camera.y}px`,
        cursor: placing ? "crosshair" : handCursor ? "grab" : "default",
        touchAction: "none",
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onFile}
      />

      {uploadError ? (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute left-4 top-4 z-30 max-w-xs rounded-2xl border border-destructive/20 bg-card px-3.5 py-2 text-xs text-destructive shadow-[0_10px_30px_rgba(30,30,60,0.12)]"
        >
          {uploadError}
          <button
            type="button"
            onClick={() => setUploadError(null)}
            className="ml-2 text-muted-foreground hover:text-foreground"
            aria-label="关闭上传错误提示"
          >
            ×
          </button>
        </div>
      ) : null}

      {/* items */}
      {items.map((it) => {
        const left = it.x * zoom + camera.x;
        const top = it.y * zoom + camera.y;
        const w = it.w * zoom;
        const h = it.h * zoom;
        const isSel = selected.has(it.key);
        // 对话引用态（prd_agent 画布同款）：灰罩✓ = 灰待选；序号角标 = 已确认。
        const refSt =
          it.kind === "image"
            ? ((it.versionId && chatRefStates?.[it.versionId]) ||
                (it.assetId && chatRefStates?.[it.assetId]) ||
                null)
            : null;
        return (
          <div
            key={it.key}
            data-testid="canvas-item"
            data-kind={it.kind}
            data-selected={isSel ? "1" : "0"}
            className="group/citem"
            onPointerDown={(e) => beginItemDrag(e, it.key)}
            onDoubleClick={(e) => {
              if (it.kind === "text") {
                e.stopPropagation();
                setSelected(new Set([it.key]));
                setEditingText(it.key);
              }
            }}
            style={{
              position: "absolute",
              left,
              top,
              width: w,
              height: h,
              cursor: handCursor ? "inherit" : "move",
            }}
          >
            {it.kind === "image" && it.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={it.imageUrl}
                alt="画布图片"
                draggable={false}
                className="h-full w-full rounded-[6px] object-contain"
                style={{ background: "rgb(244 240 255 / 0.5)" }}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (!it.naturalW && img.naturalWidth) {
                    setItems((prev) =>
                      prev.map((p) =>
                        p.key === it.key
                          ? {
                              ...p,
                              naturalW: img.naturalWidth,
                              naturalH: img.naturalHeight,
                            }
                          : p,
                      ),
                    );
                  }
                }}
              />
            ) : it.kind === "shape" ? (
              <ShapeView item={it} />
            ) : editingText === it.key ? (
              <textarea
                ref={editTextRef}
                defaultValue={it.text}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  // Esc / ⌘·Ctrl+Enter 提交退出编辑(Enter 仍是换行)。
                  if (
                    e.key === "Escape" ||
                    (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                  ) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.blur();
                  }
                }}
                onBlur={(e) => {
                  commitTextEdit(it.key, e.target.value);
                }}
                className="h-full w-full resize-none rounded-[6px] border border-primary/40 bg-card p-1 outline-none"
                style={{ fontSize: (it.fontSize ?? 18) * zoom, color: it.color }}
              />
            ) : (
              <div
                className="h-full w-full overflow-hidden whitespace-pre-wrap break-words p-1"
                style={{
                  fontSize: (it.fontSize ?? 18) * zoom,
                  color: it.color ?? "rgb(31 31 42)",
                  lineHeight: 1.3,
                }}
              >
                {it.text}
              </div>
            )}

            {/* 上传同步态角标（prd_agent「同步中/未持久化」同款语义） */}
            {it.kind === "image" && it.syncStatus === "pending" ? (
              <span className="pointer-events-none absolute right-1 top-1 z-40 animate-pulse rounded-full bg-card/90 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shadow">
                同步中…
              </span>
            ) : null}
            {it.kind === "image" && it.syncStatus === "failed" ? (
              <span
                className="pointer-events-none absolute right-1 top-1 z-40 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white shadow"
                style={{ background: "rgba(239,68,68,0.85)" }}
                title="图片未持久化到资产库，刷新可能丢失"
              >
                未持久化
              </span>
            ) : null}

            {/* hover 淡蓝边框（prd_agent Tab:6448-6462 同款）：未选中、非待选的图片 */}
            {it.kind === "image" && it.imageUrl && !isSel && !refSt ? (
              <div
                className="pointer-events-none absolute inset-0 rounded-[6px] opacity-0 transition-opacity duration-200 group-hover/citem:opacity-100"
                style={{
                  border: "2px solid rgba(147,197,253,0.55)",
                  boxShadow:
                    "0 0 16px rgba(96,165,250,0.18), inset 0 0 8px rgba(96,165,250,0.06)",
                  zIndex: 30,
                }}
              />
            ) : null}

            {/* 对话引用两阶段态（prd_agent Tab:6465-6493 同款）：
                灰待选 = 灰罩 + 居中✓；已确认 = violet 序号角标 */}
            {refSt && !refSt.ready ? (
              <div
                className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[6px]"
                style={{
                  background: "rgba(156,163,175,0.25)",
                  border: "2px solid rgba(156,163,175,0.6)",
                  zIndex: 35,
                }}
              >
                <span
                  className="font-bold text-white"
                  style={{
                    fontSize: Math.max(20, Math.min(w, h) * 0.15),
                    textShadow: "0 2px 8px rgba(0,0,0,0.5)",
                  }}
                >
                  ✓
                </span>
              </div>
            ) : null}
            {refSt?.ready ? (
              <span
                className="pointer-events-none absolute right-0 top-0 flex items-center justify-center rounded-full bg-primary font-bold text-primary-foreground"
                style={{
                  transform: "translate(50%,-50%)",
                  minWidth: 20,
                  height: 20,
                  padding: "0 6px",
                  fontSize: 11,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
                  zIndex: 40,
                }}
                title={`引用顺序: ${refSt.ordinal}`}
              >
                {refSt.ordinal}
              </span>
            ) : null}

            {/* 选择框 + 四角手柄(固定屏幕尺寸) */}
            {isSel ? (
              <>
                <div
                  className="pointer-events-none absolute -inset-px rounded-[6px]"
                  style={{ border: `2px solid ${SELECT}` }}
                />
                {(["nw", "ne", "sw", "se"] as const).map((corner) => {
                  const pos: Record<string, string> = {
                    nw: "-left-1.5 -top-1.5 cursor-nwse-resize",
                    ne: "-right-1.5 -top-1.5 cursor-nesw-resize",
                    sw: "-left-1.5 -bottom-1.5 cursor-nesw-resize",
                    se: "-right-1.5 -bottom-1.5 cursor-nwse-resize",
                  };
                  return (
                    <span
                      key={corner}
                      onPointerDown={(e) => beginResize(e, it, corner)}
                      className={`absolute h-3 w-3 rounded-full border-2 border-white shadow ${pos[corner]}`}
                      style={{ background: SELECT }}
                    />
                  );
                })}
              </>
            ) : null}
          </div>
        );
      })}

      {/* 框选矩形 */}
      {marquee ? (
        <div
          className="pointer-events-none absolute rounded-[2px]"
          style={{
            left: marquee.x,
            top: marquee.y,
            width: marquee.w,
            height: marquee.h,
            border: `1px solid ${SELECT}`,
            background: "rgba(74,155,255,0.12)",
          }}
        />
      ) : null}

      {/* 空态引导 */}
      {items.length === 0 ? (
        <CanvasEmpty
          running={running}
          status={status}
          timedOut={timedOut}
          error={error}
        />
      ) : null}

      {/* 顶部缩放工具条 */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-2 rounded-2xl border border-border bg-card/95 px-3 py-2 text-xs text-foreground shadow-[0_14px_40px_rgba(30,30,60,0.12)] backdrop-blur"
      >
        <button
          type="button"
          onClick={() => zoomByButton(0.83)}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="缩小"
        >
          −
        </button>
        <span className="min-w-12 text-center font-mono tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => zoomByButton(1.2)}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="放大"
        >
          +
        </button>
        <span className="h-5 w-px bg-border" />
        <button
          type="button"
          onClick={fitToContent}
          className="rounded-lg px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          适配
        </button>
        <button
          type="button"
          onClick={() => zoomByButton(1 / zoom)}
          className="rounded-lg px-2 py-1 font-mono text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          100%
        </button>
      </div>

      {/* 左侧工具栏(真实工具) */}
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute left-4 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-1.5 rounded-2xl border border-border bg-card/95 p-2 shadow-[0_14px_40px_rgba(30,30,60,0.12)] backdrop-blur"
      >
        <ToolBtn active={tool === "select" && !placing} title="选择" onClick={() => pickTool("select")}>
          <CursorIcon />
        </ToolBtn>
        <ToolBtn active={handCursor} title="移动画布(手型/空格)" onClick={() => pickTool("hand")}>
          <HandIcon />
        </ToolBtn>
        <span className="my-0.5 h-px bg-border" />
        <ToolBtn title="加图片(上传)" onClick={triggerUpload}>
          <ImageIcon />
        </ToolBtn>
        <ToolBtn
          active={placing?.kind === "shape" && placing.shapeType === "rect"}
          title="加矩形"
          onClick={() => setPlacing({ kind: "shape", shapeType: "rect" })}
        >
          <span className="block h-3.5 w-3.5 rounded-[3px] border-2 border-current" />
        </ToolBtn>
        <ToolBtn
          active={placing?.kind === "shape" && placing.shapeType === "circle"}
          title="加圆形"
          onClick={() => setPlacing({ kind: "shape", shapeType: "circle" })}
        >
          <span className="block h-3.5 w-3.5 rounded-full border-2 border-current" />
        </ToolBtn>
        <ToolBtn
          active={placing?.kind === "text"}
          title="加文字"
          onClick={() => setPlacing({ kind: "text" })}
        >
          <span className="text-sm font-semibold">T</span>
        </ToolBtn>
        <span className="my-0.5 h-px bg-border" />
        <ToolBtn title="上移一层" disabled={!selected.size} onClick={() => reorder("up")}>
          <span className="text-xs">↑</span>
        </ToolBtn>
        <ToolBtn title="下移一层" disabled={!selected.size} onClick={() => reorder("down")}>
          <span className="text-xs">↓</span>
        </ToolBtn>
        <ToolBtn title="置顶" disabled={!selected.size} onClick={() => reorder("front")}>
          <span className="text-[10px] font-semibold">顶</span>
        </ToolBtn>
        <ToolBtn title="置底" disabled={!selected.size} onClick={() => reorder("back")}>
          <span className="text-[10px] font-semibold">底</span>
        </ToolBtn>
        <span className="my-0.5 h-px bg-border" />
        <ToolBtn
          title="删除选中"
          disabled={!selected.size}
          onClick={() => {
            setItems((p) => {
            for (const it of p)
              if (selected.has(it.key) && it.versionId)
                removedVersionIdsRef.current.add(it.versionId);
            return p.filter((it) => !selected.has(it.key));
          });
            bumpRemovedNonce();
            setSelected(new Set());
          }}
        >
          <TrashIcon />
        </ToolBtn>
      </div>

      {/* 放置提示 */}
      {placing ? (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-card/95 px-3 py-1.5 text-xs text-muted-foreground shadow backdrop-blur">
          在画布上点击放置{placing.kind === "text" ? "文字" : "形状"}(Esc 取消)
        </div>
      ) : null}

      {/* 选中出图变体 → 操作条(局部重画/扩展/换背景…接真实改图)。
          arm-then-confirm:点 op chip 只「选中操作」(高亮),输入指令后回车/点「出图」
          才真正改图;局部重画(mask)点了直接开涂抹层(自带指令+确认)。布局固定不随
          交互增减元素,避免居中工具条左右抖动。*/}
      {soloVersion ? (() => {
        // V0.0.13h — 操作条贴图（prd_agent ImageQuickActionBar 位置语义）：
        // 浮在选中图片正上方居中、跟随图片与相机变换；贴近画布顶部时翻到图片下方。
        const soloIt = items.find((i) => selectedKeys.length === 1 && i.key === selectedKeys[0]);
        const cx = soloIt ? (soloIt.x + soloIt.w / 2) * zoom + camera.x : 0;
        const topY = soloIt ? soloIt.y * zoom + camera.y : 0;
        const bottomY = soloIt ? (soloIt.y + soloIt.h) * zoom + camera.y : 0;
        const flip = topY < 120; // 上方放不下 → 放图片下方
        const barStyle: React.CSSProperties = soloIt
          ? {
              left: Math.max(160, Math.min(cx, 99999)),
              top: flip ? bottomY + 12 : undefined,
              bottom: flip ? undefined : undefined,
              transform: "translate(-50%, 0)",
              ...(flip ? {} : { top: Math.max(8, topY - 12), transform: "translate(-50%, -100%)" }),
            }
          : { left: "50%", top: "4.5rem", transform: "translateX(-50%)" };
        return (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute z-20 flex max-w-[calc(100%-8rem)] flex-wrap items-center justify-center gap-1.5 rounded-2xl border border-border bg-card/95 px-2.5 py-2 shadow-[0_14px_40px_rgba(30,30,60,0.12)] backdrop-blur"
          style={barStyle}
        >
          {edit.ops.map((o) => {
            const active = o.mask ? false : armedOp === o.value;
            return (
              <button
                key={o.value}
                type="button"
                disabled={edit.busy}
                aria-pressed={active}
                onClick={() => {
                  if (o.mask) {
                    edit.onOpenMask(soloVersion);
                  } else {
                    // 仅「选中」该操作,不立即改图(等指令 + 确认)。
                    setArmedOp((prev) => (prev === o.value ? null : o.value));
                  }
                }}
                title={o.mask ? "在图片上涂抹要重绘的区域" : `选「${o.label}」,再输入指令出图`}
                className={[
                  "rounded-full px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
                  o.mask
                    ? "bg-gradient-to-br from-primary to-accent font-medium text-primary-foreground shadow-[0_6px_16px_rgba(124,92,255,0.24)]"
                    : active
                      ? "bg-accent-soft font-medium text-primary ring-1 ring-primary/40"
                      : "border border-border text-muted-foreground hover:bg-muted",
                ].join(" ")}
              >
                {o.label}
              </button>
            );
          })}
          <span className="mx-0.5 h-5 w-px bg-border" />
          <input
            value={edit.instr}
            onChange={(e) => edit.onInstrChange(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter" && armedOp && edit.instr.trim() && !edit.busy) {
                e.preventDefault();
                edit.onRun(soloVersion, armedOp);
              }
            }}
            placeholder={
              armedOp
                ? `描述「${edit.ops.find((o) => o.value === armedOp)?.label ?? "修改"}」细节,回车出图…`
                : "先选上方操作,再描述修改…"
            }
            disabled={edit.busy}
            className="h-8 w-44 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-primary/40 disabled:opacity-50"
          />
          <button
            type="button"
            // 必须先选操作 + 有非空指令才可出图 —— 否则空 prompt 会触发一次真实 provider
            // 改图,白烧配额且结果含糊(Codex P2:旧表单原本 guard 了 !instr.trim())。
            disabled={edit.busy || !armedOp || !edit.instr.trim()}
            onClick={() => {
              if (armedOp && edit.instr.trim() && !edit.busy)
                edit.onRun(soloVersion, armedOp);
            }}
            title={
              !armedOp
                ? "先选一个操作"
                : !edit.instr.trim()
                  ? "先输入修改指令"
                  : "用上方选中的操作 + 指令改图"
            }
            className="h-8 rounded-lg bg-gradient-to-br from-primary to-accent px-3 text-xs font-medium text-primary-foreground shadow-[0_6px_16px_rgba(124,92,255,0.24)] transition-opacity disabled:opacity-40"
          >
            {edit.busy ? "改图中…" : "出图"}
          </button>

          {/* V0.0.13e — 终选/交付/审阅（原下方面板已删，动作跟随画布选中） */}
          {edit.delivery ? (
            <>
              <span className="mx-0.5 h-5 w-px bg-border" />
              <button
                type="button"
                onClick={edit.delivery.onMarkFinal}
                disabled={
                  edit.delivery.busy === "final" || edit.delivery.isFinal
                }
                className="rounded-full border border-success/40 px-2.5 py-1 text-xs text-success transition-colors hover:bg-success/10 disabled:opacity-60"
              >
                {edit.delivery.isFinal ? "✓ 终稿" : "设为终稿"}
              </button>
              <button
                type="button"
                onClick={edit.delivery.onExport}
                disabled={edit.delivery.busy === "export"}
                className="rounded-full border border-primary/40 px-2.5 py-1 text-xs text-primary transition-colors hover:bg-accent-soft disabled:opacity-60"
              >
                {edit.delivery.busy === "export"
                  ? "打包中…"
                  : edit.delivery.hasFinal
                    ? "导出(终稿)"
                    : "导出(当前图)"}
              </button>
              {edit.delivery.canSubmitReview ? (
                <button
                  type="button"
                  onClick={edit.delivery.onSubmitReview}
                  disabled={edit.delivery.reviewBusy}
                  className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
                >
                  提交审阅
                </button>
              ) : null}
              {edit.delivery.canDecideReview ? (
                <>
                  <button
                    type="button"
                    onClick={edit.delivery.onApprove}
                    disabled={edit.delivery.reviewBusy}
                    className="rounded-full border border-success/40 px-2.5 py-1 text-xs text-success transition-colors hover:bg-success/10 disabled:opacity-60"
                  >
                    通过
                  </button>
                  <button
                    type="button"
                    onClick={edit.delivery.onOpenReject}
                    disabled={edit.delivery.reviewBusy}
                    className="rounded-full border border-destructive/40 px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-60"
                  >
                    驳回
                  </button>
                </>
              ) : null}
              {edit.delivery.reviewStatus ? (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  {edit.delivery.reviewStatus}
                </span>
              ) : null}
              {edit.delivery.error ? (
                <span className="text-[10px] text-destructive">
                  {edit.delivery.error}
                </span>
              ) : null}
            </>
          ) : null}
        </div>
        );
      })() : null}
    </div>
  );
}

function ShapeView({ item }: { item: CanvasItem }) {
  const common = {
    width: "100%",
    height: "100%",
    background: item.fill,
    border: `2px solid ${item.stroke ?? "rgb(91 63 224)"}`,
  } as const;
  if (item.shapeType === "circle")
    return <div style={{ ...common, borderRadius: "50%" }} />;
  if (item.shapeType === "triangle")
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: item.fill,
          clipPath: "polygon(50% 0%, 100% 100%, 0% 100%)",
        }}
      />
    );
  if (item.shapeType === "star")
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: item.fill,
          clipPath:
            "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)",
        }}
      />
    );
  return <div style={{ ...common, borderRadius: 8 }} />;
}

function CanvasEmpty({
  running,
  status,
  timedOut,
  error,
}: {
  running: boolean;
  status: string | null;
  timedOut: boolean;
  error?: string;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
      {timedOut ? (
        <>
          <div className="text-sm text-warning">生成超时</div>
          <p className="mt-1 text-xs text-muted-foreground">可能仍在后台,稍后重试。</p>
        </>
      ) : status === "FAILED" ? (
        <>
          <div className="text-sm text-destructive">生成失败</div>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {error || "请检查 AI provider 配置或稍后重试。"}
          </p>
        </>
      ) : running ? (
        <>
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-accent-soft border-t-primary" />
          <div className="mt-3 text-sm text-muted-foreground">
            {status === "PENDING" ? "已受理,排队中…" : "AI 正在生成…"}
          </div>
        </>
      ) : (
        <>
          <div className="text-5xl text-accent-soft">✸</div>
          <div className="mt-3 text-sm font-medium">空画布</div>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            右侧提交制作出图,变体会落到画布;左侧工具可加图片/形状/文字。
          </p>
        </>
      )}
    </div>
  );
}

function ToolBtn({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      className={[
        "flex h-9 w-9 items-center justify-center rounded-xl text-base transition-colors disabled:opacity-35",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function CursorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="m4 3 7 17 2.5-6.5L20 11 4 3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
function HandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 11V6.5a1.5 1.5 0 0 1 3 0V11m0-1.5v-3a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V12m0-.5a1.5 1.5 0 0 1 3 0V15a5 5 0 0 1-5 5h-1.5a5 5 0 0 1-4.2-2.3L5 14.5c-.6-1 .2-2 1.2-1.7L9 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ImageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="8.5" cy="9.5" r="1.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="m4 17 5-4 4 3 3-2 4 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 7h16M9 7V5h6v2m-7 0 1 13h6l1-13" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

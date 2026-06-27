"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  naturalW?: number;
  naturalH?: number;
  // shape
  shapeType?: ShapeType;
  fill?: string;
  stroke?: string;
  // text
  text?: string;
  fontSize?: number;
  color?: string;
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
};

export function OpenCanvas({
  seedVersions,
  running,
  status,
  timedOut,
  error,
  onSelectVersion,
  onUploadImage,
  edit,
}: {
  seedVersions: GenerationVersion[];
  running: boolean;
  status: string | null;
  timedOut: boolean;
  error?: string;
  /** 单选某张出图变体时回传 versionId(null=未选),让右下表单/终选条同步 activeVariant。 */
  onSelectVersion: (versionId: string | null) => void;
  /** 上传图片到画布:返回公网 URL + 真实尺寸。 */
  onUploadImage: (file: File) => Promise<{
    url: string;
    width?: number;
    height?: number;
  }>;
  edit: CanvasEditBridge;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const gestureRef = useRef<Gesture>(null);
  const movedRef = useRef(false);

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
  const seededRef = useRef(false);

  // 最新 viewport 放 ref,wheel 监听只绑一次。
  const vpRef = useRef({ zoom, camera });
  vpRef.current = { zoom, camera };

  // 出图变体 → 画布图片 item:增量合并(保留手工布局/形状/文字;切 generation 时
  // 移除已不在的版本;改图新子版本自动作为新 item 浮现)。
  useEffect(() => {
    setItems((prev) => {
      const vids = new Set(seedVersions.map((v) => v.id));
      const kept = prev.filter((it) => !it.versionId || vids.has(it.versionId));
      const have = new Set(
        kept.filter((it) => it.versionId).map((it) => it.versionId),
      );
      const base = kept.length;
      const add = seedVersions
        .filter((v) => !have.has(v.id))
        .map((v, i) => imageItemFromVersion(v, base + i));
      return add.length ? [...kept, ...add] : kept;
    });
  }, [seedVersions]);

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

  // 首批 item 落地后自动适配一次。
  useEffect(() => {
    if (!seededRef.current && items.length > 0) {
      seededRef.current = true;
      fitToContent();
    }
  }, [items, fitToContent]);

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
          setItems((p) => p.filter((it) => !selected.has(it.key)));
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
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const { url, width, height } = await onUploadImage(f);
      const ratio = width && height ? width / height : 1;
      const w = 280;
      const h = Math.round(w / (ratio || 1));
      const c = centerScreen();
      const wp = toWorld(c.x, c.y);
      const item: CanvasItem = {
        key: uid("img"),
        kind: "image",
        imageUrl: url,
        naturalW: width,
        naturalH: height,
        x: wp.x - w / 2,
        y: wp.y - h / 2,
        w,
        h,
      };
      setItems((prev) => [...prev, item]);
      setSelected(new Set([item.key]));
    } catch {
      /* 上传失败:静默(操作条会有错误出口);P1 不阻断画布 */
    }
  };

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
    gestureRef.current = { type: "move", sx: e.clientX, sy: e.clientY, start };
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
        setSelected(new Set());
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

      {/* items */}
      {items.map((it) => {
        const left = it.x * zoom + camera.x;
        const top = it.y * zoom + camera.y;
        const w = it.w * zoom;
        const h = it.h * zoom;
        const isSel = selected.has(it.key);
        return (
          <div
            key={it.key}
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
                autoFocus
                defaultValue={it.text}
                onPointerDown={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const v = e.target.value;
                  setItems((prev) =>
                    prev.map((p) => (p.key === it.key ? { ...p, text: v } : p)),
                  );
                  setEditingText(null);
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
      <div className="absolute left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-2 rounded-2xl border border-border bg-card/95 px-3 py-2 text-xs text-foreground shadow-[0_14px_40px_rgba(30,30,60,0.12)] backdrop-blur">
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
      <div className="absolute left-4 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-1.5 rounded-2xl border border-border bg-card/95 p-2 shadow-[0_14px_40px_rgba(30,30,60,0.12)] backdrop-blur">
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
            setItems((p) => p.filter((it) => !selected.has(it.key)));
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

      {/* 选中出图变体 → 操作条(局部重画/扩展/换背景…接真实改图) */}
      {soloVersion ? (
        <div className="absolute left-1/2 top-[4.5rem] z-20 flex max-w-[calc(100%-8rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-2xl border border-border bg-card/95 px-2.5 py-2 shadow-[0_14px_40px_rgba(30,30,60,0.12)] backdrop-blur">
          {edit.ops.map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={edit.busy}
              onClick={() =>
                o.mask ? edit.onOpenMask(soloVersion) : edit.onRun(soloVersion, o.value)
              }
              title={o.mask ? "在图片上涂抹要重绘的区域" : o.label}
              className={[
                "rounded-full px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
                o.mask
                  ? "bg-gradient-to-br from-primary to-accent font-medium text-primary-foreground shadow-[0_6px_16px_rgba(124,92,255,0.24)]"
                  : "border border-border text-muted-foreground hover:bg-muted",
              ].join(" ")}
            >
              {o.label}
            </button>
          ))}
          <span className="mx-0.5 h-5 w-px bg-border" />
          <input
            value={edit.instr}
            onChange={(e) => edit.onInstrChange(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            placeholder="描述修改…(配合左侧操作选项)"
            disabled={edit.busy}
            className="h-8 w-44 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-primary/40"
          />
          <span className="text-[11px] text-muted-foreground">
            {edit.busy ? "改图中…" : "点操作出图"}
          </span>
        </div>
      ) : null}
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

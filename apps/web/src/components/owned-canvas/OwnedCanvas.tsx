"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { OwnedCanvasDocument, OwnedCanvasItem } from "@/lib/owned-canvas-model";
import { applyEdit, bounds, boxBetween, center, clamp, corners, createEdit, intersects, itemCenter, resize, resizeMany, rotate, type Bounds, type CanvasEdit, type Corner, type Point } from "./geometry";
import "./owned-canvas.css";

export type OwnedCanvasProps = {
  document: OwnedCanvasDocument;
  onChange: (next: OwnedCanvasDocument) => void;
  readOnly?: boolean;
  onUploadFiles?: (files: File[], point?: Point) => Promise<void>;
  onExport?: (format: "png" | "svg") => Promise<void>;
  onSelectionChange?: (ids: string[]) => void;
};
type Tool = "select" | "hand" | "text" | "stroke" | "shape" | "frame";
type Gesture = { type: "move" | "resize" | "rotate" | "pan" | "marquee" | "draw"; pointerId: number; start: Point; screen: Point; before: OwnedCanvasDocument; originals: OwnedCanvasItem[]; corner?: Corner; box?: Bounds; pivot?: Point; angle?: number; id?: string; points?: Point[]; additive?: string[]; moved?: boolean };
const HISTORY_LIMIT = 60;
const icons: Record<string, string> = {
  select: "m5 3 14 8-7 2-3 7Z", hand: "M8 11V6a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v7-4a2 2 0 0 1 4 0v8c0 4-3 7-7 7-3 0-5-2-7-5l-3-4a2 2 0 0 1 3-2l2 2", text: "M4 5h16M12 5v15M8 20h8", stroke: "m4 17 12-12 3 3-12 12H4v-3Zm10-10 3 3", shape: "M5 4h14v16H5Z", frame: "M7 2v20M17 2v20M2 7h20M2 17h20", upload: "M12 16V3m-5 5 5-5 5 5M4 14v6h16v-6", undo: "M9 5 4 10l5 5M4 10h10a5 5 0 0 1 0 10", redo: "m15 5 5 5-5 5m5-5H10a5 5 0 0 0 0 10", trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7", layers: "m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 17l10 5 10-5", download: "M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4", rotate: "M4 9a8 8 0 1 1 0 7M4 3v6h6", plus: "M12 4v16M4 12h16", minus: "M4 12h16", fit: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5", up: "m6 14 6-6 6 6", down: "m6 10 6 6 6-6",
};
function Icon({ name }: { name: string }) { return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name] || icons.shape} /></svg>; }
function starPoints(w: number, h: number) { return Array.from({ length: 10 }, (_, index) => { const angle = -Math.PI / 2 + index * Math.PI / 5, radius = index % 2 ? 0.21 : 0.5; return `${w / 2 + Math.cos(angle) * w * radius},${h / 2 + Math.sin(angle) * h * radius}`; }).join(" "); }
function Shape({ item }: { item: OwnedCanvasItem }) {
  const strokeWidth = item.strokeWidth ?? 2, common = { strokeLinejoin: "round" as const, fill: item.fill ?? "#ede9fe", stroke: item.stroke ?? "#7c5cff", strokeWidth };
  return <svg width="100%" height="100%" viewBox={`0 0 ${item.w} ${item.h}`} overflow="visible" aria-hidden="true">{item.kind === "stroke" ? item.points?.length === 1 ? <circle cx={item.points[0]!.x} cy={item.points[0]!.y} r={strokeWidth / 2} fill={item.stroke ?? "#7c5cff"} /> : <polyline points={(item.points ?? []).map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke={item.stroke ?? "#7c5cff"} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" /> : item.shape === "ellipse" ? <ellipse cx={item.w / 2} cy={item.h / 2} rx={item.w / 2} ry={item.h / 2} {...common} /> : item.shape === "triangle" ? <polygon points={`${item.w / 2},0 ${item.w},${item.h} 0,${item.h}`} {...common} /> : item.shape === "star" ? <polygon points={starPoints(item.w, item.h)} {...common} /> : <rect width={item.w} height={item.h} {...common} />}</svg>;
}
const itemName = (item: OwnedCanvasItem) => item.kind === "text" ? item.text?.split("\n")[0]?.slice(0, 30) || "文字" : ({ image: "图片", shape: "图形", stroke: "笔迹", frame: "画框" }[item.kind]);
const inputTarget = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest("input,textarea,select,[contenteditable=true]"));

export function OwnedCanvas({ document: incoming, onChange, readOnly = false, onUploadFiles, onExport, onSelectionChange }: OwnedCanvasProps) {
  const [view, setView] = useState(incoming), live = useRef(incoming), emitted = useRef<OwnedCanvasDocument | null>(null);
  const callbacks = useRef({ onChange, onUploadFiles, onExport, onSelectionChange }); callbacks.current = { onChange, onUploadFiles, onExport, onSelectionChange };
  const root = useRef<HTMLDivElement>(null), uploader = useRef<HTMLInputElement>(null), editor = useRef<HTMLTextAreaElement>(null);
  const [selected, setSelected] = useState<string[]>([]), selectedRef = useRef<string[]>([]);
  const [tool, setTool] = useState<Tool>("select"), [shape, setShape] = useState<NonNullable<OwnedCanvasItem["shape"]>>("rect"), [color, setColor] = useState("#7c5cff"), [lineWidth, setLineWidth] = useState(3);
  const [marquee, setMarquee] = useState<Bounds | null>(null), [editing, setEditing] = useState<string | null>(null), [text, setText] = useState("");
  const editBefore = useRef<OwnedCanvasDocument | null>(null), editingRef = useRef<string | null>(null), composing = useRef(false);
  const [layers, setLayers] = useState(false), [exportMenu, setExportMenu] = useState(false), [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false), [historyVersion, setHistoryVersion] = useState(0), [spaceDown, setSpaceDown] = useState(false);
  const history = useRef<CanvasEdit[]>([]), future = useRef<CanvasEdit[]>([]), gesture = useRef<Gesture | null>(null), space = useRef(false);
  const lastTap = useRef({ id: "", time: 0, x: 0, y: 0 }), wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locked = readOnly || view.warnings.length > 0, lockedRef = useRef(locked); lockedRef.current = locked;
  const updateView = useCallback((next: OwnedCanvasDocument) => { live.current = next; setView(next); }, []);
  const choose = useCallback((ids: string[]) => { selectedRef.current = ids; setSelected(ids); callbacks.current.onSelectionChange?.(ids); }, []);
  const emit = useCallback((next: OwnedCanvasDocument) => { updateView(next); emitted.current = next; callbacks.current.onChange(next); }, [updateView]);
  const complete = useCallback((before: OwnedCanvasDocument, next: OwnedCanvasDocument) => {
    if (lockedRef.current) return;
    const edit = createEdit(before, next);
    if (edit) { history.current = [...history.current.slice(-(HISTORY_LIMIT - 1)), edit]; future.current = []; setHistoryVersion(v => v + 1); emit(next); }
    else updateView(next);
  }, [emit, updateView]);

  useEffect(() => {
    if (incoming === emitted.current) return;
    const samePage = incoming.pageId === live.current.pageId;
    if (!samePage) { gesture.current = null; history.current = []; future.current = []; choose([]); setEditing(null); editingRef.current = null; setHistoryVersion(v => v + 1); }
    if (samePage && !lockedRef.current) {
      const previousIds = new Set(live.current.items.map(item => item.id)), added = incoming.items.filter(item => !previousIds.has(item.id));
      if (added.length) {
        // An upload/generation callback owns its persistence; record its new
        // IDs as one reversible insertion without replaying onChange on receipt.
        history.current = [...history.current.slice(-(HISTORY_LIMIT - 1)), { changes: added.map(item => ({ id: item.id, after: item })), beforeOrder: live.current.items.map(item => item.id), afterOrder: incoming.items.map(item => item.id) }];
        future.current = []; setHistoryVersion(v => v + 1);
      }
    }
    const active = gesture.current;
    if (active && incoming.pageId === live.current.pageId) {
      const touched = new Set([...active.originals.map(item => item.id), ...(active.id ? [active.id] : [])]);
      const drafts = new Map(live.current.items.filter(item => touched.has(item.id)).map(item => [item.id, item]));
      const existingIds = new Set(incoming.items.map(item => item.id));
      updateView({ ...incoming, items: [...incoming.items.map(item => drafts.get(item.id) ?? item), ...[...drafts.values()].filter(item => !existingIds.has(item.id))], camera: live.current.camera });
    } else updateView(incoming);
    const existing = new Set(live.current.items.map(item => item.id));
    if (selectedRef.current.some(id => !existing.has(id))) choose(selectedRef.current.filter(id => existing.has(id)));
    if (editingRef.current && !existing.has(editingRef.current)) { editingRef.current = null; editBefore.current = null; setEditing(null); }
  }, [incoming, choose, updateView]);

  function screenPoint(clientX: number, clientY: number): Point { const rect = root.current!.getBoundingClientRect(); return { x: clientX - rect.left, y: clientY - rect.top }; }
  function worldPoint(clientX: number, clientY: number): Point { const p = screenPoint(clientX, clientY), camera = live.current.camera; return { x: (p.x - camera.x) / camera.zoom, y: (p.y - camera.y) / camera.zoom }; }
  function transformItems(items: OwnedCanvasItem[]) { const changed = new Map(items.map(item => [item.id, item])); updateView({ ...live.current, items: live.current.items.map(item => changed.get(item.id) ?? item) }); }
  function newItem(kind: OwnedCanvasItem["kind"], point: Point): OwnedCanvasItem { return { id: `shape:${crypto.randomUUID()}`, kind, x: point.x, y: point.y, w: 1, h: 1, rotation: 0, opacity: 1, fill: kind === "text" ? color : "#ede9fe", stroke: color, strokeWidth: lineWidth, ...(kind === "shape" ? { shape } : {}), ...(kind === "frame" ? { fill: "#ffffff" } : {}) }; }
  function capture(event: ReactPointerEvent, active: Gesture) { gesture.current = active; root.current?.setPointerCapture(event.pointerId); }
  function startText(item: OwnedCanvasItem) { if (lockedRef.current) return; editBefore.current = live.current; editingRef.current = item.id; setEditing(item.id); setText(item.text ?? ""); choose([item.id]); }
  const finishText = useCallback(() => {
    const id = editingRef.current, before = editBefore.current;
    if (!id || !before) return;
    const value = editor.current?.value ?? "";
    editingRef.current = null; editBefore.current = null; setEditing(null); composing.current = false;
    const oldItem = before.items.find(item => item.id === id);
    const currentBefore = { ...live.current, items: live.current.items.map(item => item.id === id && oldItem ? oldItem : item) };
    complete(currentBefore, { ...live.current, items: live.current.items.map(item => item.id === id ? { ...item, text: value } : item) });
  }, [complete]);
  useEffect(() => {
    if (!editing) return;
    const timer = setTimeout(() => { editor.current?.focus(); editor.current?.select(); }, 0);
    const outside = (event: PointerEvent) => { if (editor.current && !editor.current.contains(event.target as Node)) { editor.current.blur(); finishText(); } };
    window.document.addEventListener("pointerdown", outside, true);
    return () => { clearTimeout(timer); window.document.removeEventListener("pointerdown", outside, true); };
  }, [editing, finishText]);

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.button !== 1 || gesture.current || inputTarget(event.target)) return;
    if (wheelTimer.current) { clearTimeout(wheelTimer.current); wheelTimer.current = null; if (!lockedRef.current) emit(live.current); }
    root.current?.focus({ preventScroll: true });
    const point = worldPoint(event.clientX, event.clientY), screen = screenPoint(event.clientX, event.clientY), before = live.current;
    if (event.button === 1 || space.current || tool === "hand") { event.preventDefault(); capture(event, { type: "pan", start: point, screen, before, originals: [], pointerId: event.pointerId }); return; }
    if (!lockedRef.current && tool === "text") {
      const item = { ...newItem("text", point), w: 240, h: 72, text: "输入文字", fontSize: 24 };
      complete(before, { ...before, items: [...before.items, item] }); startText(item); setTool("select"); return;
    }
    if (!lockedRef.current && ["shape", "stroke", "frame"].includes(tool)) {
      event.preventDefault(); const item = newItem(tool as "shape" | "stroke" | "frame", point);
      if (tool === "stroke") item.points = [{ x: 0, y: 0 }];
      updateView({ ...before, items: [...before.items, item] }); choose([item.id]);
      capture(event, { type: "draw", start: point, screen, before, originals: [], pointerId: event.pointerId, id: item.id, points: tool === "stroke" ? [point] : undefined }); return;
    }
    const id = (event.target as Element).closest<HTMLElement>("[data-owned-id]")?.dataset.ownedId;
    const item = before.items.find(candidate => candidate.id === id);
    if (item) {
      const now = performance.now(), tap = lastTap.current;
      if (!lockedRef.current && item.kind === "text" && tap.id === item.id && now - tap.time < 350 && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 6) { lastTap.current.time = 0; startText(item); return; }
      lastTap.current = { id: item.id, time: now, x: event.clientX, y: event.clientY };
      let ids = selectedRef.current;
      if (event.shiftKey) { ids = ids.includes(item.id) ? ids.filter(value => value !== item.id) : [...ids, item.id]; choose(ids); }
      else if (!ids.includes(item.id)) { ids = [item.id]; choose(ids); }
      if (!lockedRef.current && ids.includes(item.id)) capture(event, { type: "move", start: point, screen, before, originals: before.items.filter(value => ids.includes(value.id)), pointerId: event.pointerId });
      event.preventDefault(); return;
    }
    lastTap.current.time = 0; if (!event.shiftKey) choose([]);
    capture(event, { type: "marquee", start: point, screen, before, originals: [], pointerId: event.pointerId, additive: event.shiftKey ? selectedRef.current : [] });
    setMarquee({ ...point, w: 0, h: 0 }); event.preventDefault();
  }
  function startTransform(event: ReactPointerEvent, type: "resize" | "rotate", corner?: Corner) {
    event.stopPropagation(); event.preventDefault(); if (lockedRef.current) return;
    if (wheelTimer.current) { clearTimeout(wheelTimer.current); wheelTimer.current = null; emit(live.current); }
    const items = live.current.items.filter(item => selectedRef.current.includes(item.id)), box = bounds(items); if (!box) return;
    const point = worldPoint(event.clientX, event.clientY), pivot = items.length === 1 ? itemCenter(items[0]!) : center(box);
    capture(event, { type, corner, start: point, screen: screenPoint(event.clientX, event.clientY), before: live.current, originals: items, pointerId: event.pointerId, box, pivot, angle: Math.atan2(point.y - pivot.y, point.x - pivot.x) });
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current; if (!active || active.pointerId !== event.pointerId) return;
    const point = worldPoint(event.clientX, event.clientY), screen = screenPoint(event.clientX, event.clientY), dx = point.x - active.start.x, dy = point.y - active.start.y;
    if (Math.hypot(screen.x - active.screen.x, screen.y - active.screen.y) > 2) active.moved = true;
    if (active.type === "pan") updateView({ ...live.current, camera: { ...active.before.camera, x: active.before.camera.x + screen.x - active.screen.x, y: active.before.camera.y + screen.y - active.screen.y } });
    else if (active.type === "marquee") { const box = boxBetween(active.start, point); setMarquee(box); choose([...new Set([...(active.additive ?? []), ...live.current.items.filter(item => intersects(box, bounds([item])!)).map(item => item.id)])]); }
    else if (!lockedRef.current && active.type === "move" && active.moved) transformItems(active.originals.map(item => ({ ...item, x: item.x + dx, y: item.y + dy })));
    else if (!lockedRef.current && active.type === "resize") transformItems(active.originals.length === 1 ? [resize(active.originals[0]!, active.corner!, point, active.originals[0]!.kind === "image" || event.shiftKey)] : resizeMany(active.originals, active.box!, active.corner!, point));
    else if (!lockedRef.current && active.type === "rotate") {
      let angle = Math.atan2(point.y - active.pivot!.y, point.x - active.pivot!.x) - active.angle!; if (event.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * Math.PI / 12;
      transformItems(active.originals.map(item => { const oldCenter = itemCenter(item), moved = rotate({ x: oldCenter.x - active.pivot!.x, y: oldCenter.y - active.pivot!.y }, angle), rotation = item.rotation + angle, offset = rotate({ x: item.w / 2, y: item.h / 2 }, rotation); return { ...item, rotation, x: active.pivot!.x + moved.x - offset.x, y: active.pivot!.y + moved.y - offset.y }; }));
    } else if (!lockedRef.current && active.type === "draw") {
      const item = live.current.items.find(item => item.id === active.id)!;
      if (active.points) {
        const last = active.points[active.points.length - 1]!; if (Math.hypot(point.x - last.x, point.y - last.y) < 0.8 / live.current.camera.zoom || active.points.length >= 4000) return;
        active.points.push(point); const xs = active.points.map(p => p.x), ys = active.points.map(p => p.y), x = Math.min(...xs), y = Math.min(...ys);
        transformItems([{ ...item, x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y), points: active.points.map(p => ({ x: p.x - x, y: p.y - y })) }]);
      } else { let box = boxBetween(active.start, point); if (event.shiftKey) { const size = Math.max(box.w, box.h); box = { x: dx < 0 ? active.start.x - size : active.start.x, y: dy < 0 ? active.start.y - size : active.start.y, w: size, h: size }; } transformItems([{ ...item, ...box, w: Math.max(1, box.w), h: Math.max(1, box.h) }]); }
    }
  }
  function endGesture(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    const active = gesture.current; if (!active || active.pointerId !== event.pointerId) return;
    gesture.current = null; setMarquee(null);
    if (cancel) {
      const originalItems = new Map(active.originals.map(item => [item.id, item]));
      updateView({ ...live.current, camera: active.type === "pan" ? active.before.camera : live.current.camera, items: live.current.items.filter(item => item.id !== active.id).map(item => originalItems.get(item.id) ?? item) });
    }
    else if (active.type === "pan") { if (!lockedRef.current) emit(live.current); }
    else if (active.type !== "marquee" && !lockedRef.current) {
      if (active.type === "draw" && !active.moved) { const item = live.current.items.find(item => item.id === active.id)!; transformItems([{ ...item, w: active.points ? 1 : 180, h: active.points ? 1 : 120, ...(active.points ? { points: [{ x: 0, y: 0 }, { x: 0.1, y: 0.1 }] } : {}) }]); }
      // Compute the operation delta without treating asynchronously uploaded
      // objects as part of this gesture's undo transaction.
      const touched = new Set([...active.originals.map(item => item.id), ...(active.id ? [active.id] : [])]);
      const before = { ...live.current, items: live.current.items.filter(item => !touched.has(item.id)).concat(active.originals) };
      const originalOrder = active.before.items.map(item => item.id), orderMap = new Map(before.items.map(item => [item.id, item]));
      before.items = [...originalOrder.flatMap(id => orderMap.has(id) ? [orderMap.get(id)!] : []), ...before.items.filter(item => !originalOrder.includes(item.id))];
      complete(before, live.current);
      if (active.type === "draw" && !active.points) setTool("select");
    }
    if (root.current?.hasPointerCapture(event.pointerId)) root.current.releasePointerCapture(event.pointerId);
  }
  function undo(redo = false) {
    if (lockedRef.current || gesture.current || editingRef.current) return;
    const from = redo ? future.current : history.current, to = redo ? history.current : future.current, edit = from.pop(); if (!edit) return;
    to.push(edit); const next = applyEdit(live.current, edit, redo ? "after" : "before"); emit(next); choose(selectedRef.current.filter(id => next.items.some(item => item.id === id))); setHistoryVersion(v => v + 1);
  }
  function modify(patch: Partial<OwnedCanvasItem>) { if (lockedRef.current) return; const before = live.current; complete(before, { ...before, items: before.items.map(item => selectedRef.current.includes(item.id) ? { ...item, ...patch } : item) }); }
  function remove() { if (lockedRef.current) return; const before = live.current; complete(before, { ...before, items: before.items.filter(item => !selectedRef.current.includes(item.id)) }); choose([]); }
  function layerMove(direction: "up" | "down" | "top" | "bottom") {
    if (lockedRef.current) return; const before = live.current, chosen = new Set(selectedRef.current), items = [...before.items];
    if (direction === "top" || direction === "bottom") { const yes = items.filter(item => chosen.has(item.id)), no = items.filter(item => !chosen.has(item.id)); complete(before, { ...before, items: direction === "top" ? [...no, ...yes] : [...yes, ...no] }); return; }
    if (direction === "up") { for (let i = items.length - 2; i >= 0; i--) if (chosen.has(items[i]!.id) && !chosen.has(items[i + 1]!.id)) [items[i], items[i + 1]] = [items[i + 1]!, items[i]!]; }
    else for (let i = 1; i < items.length; i++) if (chosen.has(items[i]!.id) && !chosen.has(items[i - 1]!.id)) [items[i], items[i - 1]] = [items[i - 1]!, items[i]!];
    complete(before, { ...before, items });
  }
  function zoomAt(zoom: number, point?: Point) {
    const rect = root.current?.getBoundingClientRect(); if (!rect) return;
    const p = point ?? { x: rect.width / 2, y: rect.height / 2 }, old = live.current.camera, nextZoom = clamp(zoom, 0.1, 4);
    updateView({ ...live.current, camera: { zoom: nextZoom, x: p.x - (p.x - old.x) * nextZoom / old.zoom, y: p.y - (p.y - old.y) * nextZoom / old.zoom } });
  }
  function persistCamera() { if (!lockedRef.current) emit(live.current); }
  function fit() { const box = bounds(live.current.items), rect = root.current?.getBoundingClientRect(); if (!rect) return; if (!box) updateView({ ...live.current, camera: { x: rect.width / 2, y: rect.height / 2, zoom: 1 } }); else { const zoom = clamp(Math.min((rect.width - 120) / Math.max(1, box.w), (rect.height - 180) / Math.max(1, box.h)), 0.1, 2); updateView({ ...live.current, camera: { zoom, x: rect.width / 2 - (box.x + box.w / 2) * zoom, y: rect.height / 2 - (box.y + box.h / 2) * zoom } }); } persistCamera(); }
  useEffect(() => {
    const element = root.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as Element).closest("[data-owned-ui]")) return; event.preventDefault(); if (gesture.current) return;
      if (event.ctrlKey || event.metaKey) { const rect = element.getBoundingClientRect(), p = { x: event.clientX - rect.left, y: event.clientY - rect.top }, old = live.current.camera, zoom = clamp(old.zoom * Math.exp(-event.deltaY * 0.002), 0.1, 4); updateView({ ...live.current, camera: { zoom, x: p.x - (p.x - old.x) * zoom / old.zoom, y: p.y - (p.y - old.y) * zoom / old.zoom } }); }
      else { const camera = live.current.camera, unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1; updateView({ ...live.current, camera: { ...camera, x: camera.x - event.deltaX * unit, y: camera.y - event.deltaY * unit } }); }
      if (wheelTimer.current) clearTimeout(wheelTimer.current); wheelTimer.current = setTimeout(() => { if (!lockedRef.current) emit(live.current); }, 180);
    };
    const release = () => { space.current = false; setSpaceDown(false); };
    element.addEventListener("wheel", wheel, { passive: false }); window.addEventListener("blur", release);
    return () => { element.removeEventListener("wheel", wheel); window.removeEventListener("blur", release); if (wheelTimer.current) clearTimeout(wheelTimer.current); };
  }, [emit, updateView]);
  async function upload(files: File[], point?: Point) { if (lockedRef.current || !callbacks.current.onUploadFiles || !files.length) return; setBusy(true); setStatus("正在提交图片…"); try { await callbacks.current.onUploadFiles(files, point); setStatus("上传进度见任务面板"); } catch { setStatus("图片未能加入，请保留原图后重试"); } finally { setBusy(false); } }
  async function exportDocument(format: "png" | "svg") { if (!callbacks.current.onExport) return; setExportMenu(false); setBusy(true); setStatus("正在准备导出…"); try { await callbacks.current.onExport(format); setStatus("已完成导出"); } catch (error) { setStatus(error instanceof Error ? error.message.slice(0, 240) : "导出未完成，请重试"); } finally { setBusy(false); } }
  const chosen = view.items.filter(item => selected.includes(item.id)), selectionBox = bounds(chosen), single = chosen.length === 1 ? chosen[0] : null;
  const selectionCorners = single ? corners(single) : selectionBox ? [{ x: selectionBox.x, y: selectionBox.y }, { x: selectionBox.x + selectionBox.w, y: selectionBox.y }, { x: selectionBox.x + selectionBox.w, y: selectionBox.y + selectionBox.h }, { x: selectionBox.x, y: selectionBox.y + selectionBox.h }] : [];
  const displayPoint = (point: Point) => ({ left: point.x * view.camera.zoom + view.camera.x, top: point.y * view.camera.zoom + view.camera.y });
  const stop = (event: ReactPointerEvent) => event.stopPropagation();
  void historyVersion;

  return <div ref={root} className={`oc-canvas ${tool === "hand" || spaceDown ? "oc-pan" : tool !== "select" ? "oc-create" : ""}`} data-testid="owned-canvas" tabIndex={0} aria-label="设计画布" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => endGesture(event)} onPointerCancel={event => endGesture(event, true)} onLostPointerCapture={event => { if (gesture.current) endGesture(event, true); }}
    onDragOver={event => { if (!locked && onUploadFiles) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (!locked) void upload([...event.dataTransfer.files].filter(file => file.type.startsWith("image/")), worldPoint(event.clientX, event.clientY)); }}
    onPaste={event => { if (inputTarget(event.target) || locked) return; const files = [...event.clipboardData.files].filter(file => file.type.startsWith("image/")); if (files.length) { event.preventDefault(); void upload(files); } }}
    onKeyUp={event => { if (event.code === "Space") { space.current = false; setSpaceDown(false); } }}
    onKeyDown={event => {
      if (inputTarget(event.target) || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.code === "Space") { event.preventDefault(); space.current = true; setSpaceDown(true); return; }
      const command = event.metaKey || event.ctrlKey, key = event.key.toLowerCase();
      if (command && key === "a") { event.preventDefault(); choose(live.current.items.map(item => item.id)); return; }
      if (event.key === "Escape") { choose([]); setTool("select"); setExportMenu(false); return; }
      if (locked) return;
      if (command && key === "z") { event.preventDefault(); undo(event.shiftKey); }
      else if (command && key === "y") { event.preventDefault(); undo(true); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); remove(); }
      else if (event.key.startsWith("Arrow") && selectedRef.current.length) { event.preventDefault(); const step = event.shiftKey ? 10 : 1, before = live.current; complete(before, { ...before, items: before.items.map(item => selectedRef.current.includes(item.id) ? { ...item, x: item.x + (event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0), y: item.y + (event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0) } : item) }); }
      else if (!command) { const tools: Record<string, Tool> = { v: "select", h: "hand", t: "text", p: "stroke", r: "shape", f: "frame" }; if (tools[key]) setTool(tools[key]); }
    }}>
    <div className="oc-grid" style={{ backgroundSize: `${24 * view.camera.zoom}px ${24 * view.camera.zoom}px`, backgroundPosition: `${view.camera.x}px ${view.camera.y}px` }} />
    {!view.items.length && <div className="oc-empty"><span>从一个想法开始</span><small>{locked ? "当前画布为只读" : "拖入图片，或用下方工具开始创作"}</small></div>}
    <div className="oc-world" style={{ transform: `translate(${view.camera.x}px,${view.camera.y}px) scale(${view.camera.zoom})` }}>
      {view.items.map(item => <div key={item.id} data-testid="owned-canvas-item" data-owned-id={item.id} data-kind={item.kind} data-selected={selected.includes(item.id) || undefined} className={`oc-item oc-${item.kind}`} aria-label={itemName(item)} style={{ left: item.x, top: item.y, width: item.w, height: item.h, transform: `rotate(${item.rotation}rad)`, opacity: item.opacity }}>
        {item.kind === "image" ? <img src={item.url} alt="画布图片" draggable={false} decoding="async" onError={event => { event.currentTarget.style.visibility = "hidden"; event.currentTarget.parentElement?.setAttribute("data-image-error", "true"); }} onLoad={event => { event.currentTarget.style.visibility = "visible"; event.currentTarget.parentElement?.removeAttribute("data-image-error"); }} /> : item.kind === "text" ? editing === item.id ? <textarea ref={editor} className="oc-text-edit" data-owned-ui aria-label="编辑画布文字" value={text} style={{ color: item.fill ?? "#202027", fontSize: item.fontSize ?? 24 }} onChange={event => setText(event.target.value)} onPointerDown={stop} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onBlur={() => { if (composing.current) setTimeout(finishText, 0); else finishText(); }} onKeyDown={event => { event.stopPropagation(); if (!composing.current && !event.nativeEvent.isComposing && (event.key === "Escape" || event.key === "Enter" && (event.ctrlKey || event.metaKey))) { event.preventDefault(); finishText(); root.current?.focus(); } }} /> : <svg width="100%" height="100%" viewBox={`0 0 ${item.w} ${item.h}`} aria-hidden="true"><text fontFamily="Arial, sans-serif" fontSize={item.fontSize ?? 24} fill={item.fill ?? "#202027"} xmlSpace="preserve">{(item.text ?? "").split(/\r?\n/).map((line, index) => <tspan key={index} x="0" y={(item.fontSize ?? 24) * (1 + index * 1.2)}>{line}</tspan>)}</text></svg> : item.kind === "frame" ? <div className="oc-frame-fill"><Shape item={item} /><small>画框</small></div> : <Shape item={item} />}
      </div>)}
    </div>
    {selectionBox && !editing && <div className="oc-selection"><svg className="oc-selection-lines" aria-hidden="true"><polygon points={selectionCorners.map(point => { const p = displayPoint(point); return `${p.left},${p.top}`; }).join(" ")} /></svg>{!locked && <>{selectionCorners.map((point, index) => <button key={index} tabIndex={-1} aria-label={`调整${["左上", "右上", "右下", "左下"][index]}尺寸`} className={`oc-handle oc-handle-${["nw", "ne", "se", "sw"][index]}`} style={displayPoint(point)} onPointerDown={event => startTransform(event, "resize", ["nw", "ne", "se", "sw"][index] as Corner)} />)}<button tabIndex={-1} aria-label="旋转选中元素" className="oc-rotation" style={{ ...displayPoint({ x: (selectionCorners[0]!.x + selectionCorners[1]!.x) / 2, y: (selectionCorners[0]!.y + selectionCorners[1]!.y) / 2 }), marginTop: -32 }} onPointerDown={event => startTransform(event, "rotate")}><Icon name="rotate" /></button></>}</div>}
    {marquee && <div className="oc-marquee" style={{ ...displayPoint(marquee), width: marquee.w * view.camera.zoom, height: marquee.h * view.camera.zoom }} />}
    <div className="oc-top-left" data-owned-ui onPointerDown={stop}><button aria-label="图层" aria-expanded={layers} onClick={() => setLayers(!layers)} className={layers ? "is-active" : ""}><Icon name="layers" /></button>{locked && <span className="oc-readonly">只读</span>}</div>
    {layers && <aside className="oc-layers" data-owned-ui onPointerDown={stop} aria-label="画布图层"><strong>图层 <small>{view.items.length}</small></strong>{!view.items.length && <p>还没有元素</p>}{[...view.items].reverse().map(item => <button key={item.id} className={selected.includes(item.id) ? "is-active" : ""} onClick={event => choose(event.shiftKey ? [...new Set([...selectedRef.current, item.id])] : [item.id])}><Icon name={item.kind === "stroke" ? "stroke" : item.kind === "text" ? "text" : "shape"} /><span>{itemName(item)}</span></button>)}</aside>}
    {chosen.length > 0 && !locked && !editing && <div className="oc-properties" data-owned-ui onPointerDown={stop} aria-label="选中元素属性"><span>{chosen.length === 1 ? itemName(chosen[0]!) : `${chosen.length} 个元素`}</span>{single?.kind !== "image" && <label title="颜色"><input type="color" aria-label="元素颜色" value={/^#[\da-f]{6}$/i.test((single?.kind === "stroke" ? single.stroke : single?.fill) ?? "") ? (single!.kind === "stroke" ? single!.stroke : single!.fill) : color} onChange={event => { setColor(event.target.value); modify(single?.kind === "stroke" ? { stroke: event.target.value } : { fill: event.target.value }); }} /></label>}{single?.kind === "text" && <label>字号<input type="number" aria-label="文字字号" min="8" max="240" key={`${single.id}-${single.fontSize}`} defaultValue={single.fontSize ?? 24} onBlur={event => { const value = Number(event.target.value); if (Number.isFinite(value)) modify({ fontSize: clamp(value, 8, 240) }); }} /></label>}{single?.kind === "stroke" && <label>粗细<input type="number" aria-label="笔迹粗细" min="1" max="80" key={`${single.id}-${single.strokeWidth}`} defaultValue={single.strokeWidth ?? 3} onBlur={event => { const value = Number(event.target.value); if (Number.isFinite(value)) modify({ strokeWidth: clamp(value, 1, 80) }); }} /></label>}<label title="不透明度">透明度<input type="number" aria-label="不透明度" min="0" max="100" key={single ? `${single.id}-${single.opacity}` : selected.join()} defaultValue={Math.round((single?.opacity ?? 1) * 100)} onBlur={event => { const value = Number(event.target.value); if (Number.isFinite(value)) modify({ opacity: clamp(value / 100, 0, 1) }); }} /></label><button aria-label="上移一层" title="上移一层" onClick={() => layerMove("up")}><Icon name="up" /></button><button aria-label="下移一层" title="下移一层" onClick={() => layerMove("down")}><Icon name="down" /></button><button aria-label="置于顶层" title="置于顶层" onClick={() => layerMove("top")}>置顶</button><button aria-label="置于底层" title="置于底层" onClick={() => layerMove("bottom")}>置底</button><button aria-label="删除选中元素" title="删除" onClick={remove}><Icon name="trash" /></button></div>}
    <div className="oc-dock" data-owned-ui onPointerDown={stop} aria-label="画布工具"><button aria-label="选择" title="选择 V" className={tool === "select" ? "is-active" : ""} onClick={() => setTool("select")}><Icon name="select" /></button><button aria-label="移动画布" title="移动画布 H / 空格" className={tool === "hand" ? "is-active" : ""} onClick={() => setTool("hand")}><Icon name="hand" /></button><i />{([['text', '文字', 'T'], ['stroke', '画笔', 'P'], ['shape', '图形', 'R'], ['frame', '画框', 'F']] as const).map(([value, label, key]) => <button key={value} aria-label={label} title={`${label} ${key}`} disabled={locked} className={tool === value ? "is-active" : ""} onClick={() => setTool(value)}><Icon name={value} /></button>)}<button aria-label="上传图片" title="上传图片" disabled={locked || busy || !onUploadFiles} onClick={() => uploader.current?.click()}><Icon name="upload" /></button><i /><button aria-label="撤销" title="撤销 Ctrl+Z" disabled={locked || !history.current.length} onClick={() => undo()}><Icon name="undo" /></button><button aria-label="重做" title="重做 Ctrl+Shift+Z" disabled={locked || !future.current.length} onClick={() => undo(true)}><Icon name="redo" /></button><button aria-label="导出" title="导出" disabled={busy || !onExport} aria-expanded={exportMenu} onClick={() => setExportMenu(!exportMenu)}><Icon name="download" /></button></div>
    {!locked && (tool === "shape" || tool === "stroke") && <div className="oc-tool-options" data-owned-ui onPointerDown={stop}>{tool === "shape" ? <select aria-label="图形种类" value={shape} onChange={event => setShape(event.target.value as typeof shape)}><option value="rect">矩形</option><option value="ellipse">椭圆</option><option value="triangle">三角形</option><option value="star">星形</option></select> : <label>粗细<input type="number" aria-label="画笔粗细" min="1" max="80" value={lineWidth} onChange={event => setLineWidth(clamp(Number(event.target.value) || 1, 1, 80))} /></label>}<input type="color" aria-label="画笔颜色" value={color} onChange={event => setColor(event.target.value)} /></div>}
    {exportMenu && <div className="oc-export-menu" data-owned-ui onPointerDown={stop}><button aria-label="导出PNG" onClick={() => void exportDocument("png")}>导出 PNG 图片</button><button aria-label="导出SVG" onClick={() => void exportDocument("svg")}>导出 SVG 矢量图</button></div>}
    <div className="oc-zoom" data-owned-ui onPointerDown={stop}><button aria-label="缩小" onClick={() => { zoomAt(view.camera.zoom / 1.2); persistCamera(); }}><Icon name="minus" /></button><button aria-label="恢复100%缩放" onClick={() => { zoomAt(1); persistCamera(); }}>{Math.round(view.camera.zoom * 100)}%</button><button aria-label="放大" onClick={() => { zoomAt(view.camera.zoom * 1.2); persistCamera(); }}><Icon name="plus" /></button><button aria-label="适合画布" title="适合画布" onClick={fit}><Icon name="fit" /></button></div>
    <div className="oc-status" role="status" aria-live="polite" data-owned-ui onPointerDown={stop}>{status || (view.warnings.length ? "此项目包含尚未支持的内容，已保留原稿并以只读方式打开。" : "")}</div>
    <input ref={uploader} type="file" accept="image/*" multiple hidden onChange={event => { void upload(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
  </div>;
}

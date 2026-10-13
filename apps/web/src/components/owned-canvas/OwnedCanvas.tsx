"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { OwnedCanvasDocument, OwnedCanvasItem } from "@/lib/owned-canvas-model";
import { alignItems, attachItemsToFrame, deleteItems, distributeItems, duplicateItems, expandSelection, getMoveSnap, getSceneFlags, groupItems, reorderItems, ungroupItems } from "@/lib/owned-canvas-operations";
import { getOwnedArrowMarker, getOwnedImageLayout, getOwnedLinePoints, getOwnedTextLayout } from "@/lib/owned-canvas-style";
import { applyEdit, bounds, boxBetween, center, clamp, corners, createEdit, intersects, itemCenter, resize, resizeMany, rotate, type Bounds, type CanvasEdit, type Corner, type Point } from "./geometry";
import "./owned-canvas.css";

export type OwnedCanvasProps = {
  document: OwnedCanvasDocument;
  onChange: (next: OwnedCanvasDocument) => void;
  readOnly?: boolean;
  onUploadFiles?: (files: File[], point?: Point) => Promise<void>;
  onExport?: (format: "png" | "svg", scope?: { itemIds?: string[]; frameId?: string }) => Promise<void>;
  onReplaceImage?: (itemId: string, files: File[]) => Promise<Pick<OwnedCanvasItem, "url" | "assetId" | "assetSha256" | "versionId"> | null>;
  clipboardScope?: string;
  onSelectionChange?: (ids: string[]) => void;
};
type Tool = "select" | "hand" | "text" | "stroke" | "shape" | "frame" | "eraser";
type Gesture = { type: "move" | "resize" | "rotate" | "pan" | "marquee" | "draw" | "erase"; pointerId: number; start: Point; screen: Point; before: OwnedCanvasDocument; originals: OwnedCanvasItem[]; corner?: Corner; box?: Bounds; pivot?: Point; angle?: number; id?: string; points?: Point[]; additive?: string[]; moved?: boolean; line?: boolean; erased?: string[] };
type Crop = NonNullable<OwnedCanvasItem["crop"]>;
type ObjectClipboard = { pageId: string; scope: string | undefined; items: OwnedCanvasItem[]; ids: string[]; count: number };
const HISTORY_LIMIT = 60;
const icons: Record<string, string> = {
  select: "m5 3 14 8-7 2-3 7Z", hand: "M8 11V6a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v7-4a2 2 0 0 1 4 0v8c0 4-3 7-7 7-3 0-5-2-7-5l-3-4a2 2 0 0 1 3-2l2 2", text: "M4 5h16M12 5v15M8 20h8", stroke: "m4 17 12-12 3 3-12 12H4v-3Zm10-10 3 3", shape: "M5 4h14v16H5Z", frame: "M7 2v20M17 2v20M2 7h20M2 17h20", upload: "M12 16V3m-5 5 5-5 5 5M4 14v6h16v-6", undo: "M9 5 4 10l5 5M4 10h10a5 5 0 0 1 0 10", redo: "m15 5 5 5-5 5m5-5H10a5 5 0 0 0 0 10", trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7", layers: "m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 17l10 5 10-5", download: "M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4", rotate: "M4 9a8 8 0 1 1 0 7M4 3v6h6", plus: "M12 4v16M4 12h16", minus: "M4 12h16", fit: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5", up: "m6 14 6-6 6 6", down: "m6 10 6 6 6-6",
};
icons.eraser = "m4 15 10-11 7 7-9 10H7l-3-3Zm4-4 8 8M12 21h9";
icons.more = "M5 12h.01M12 12h.01M19 12h.01";
icons.eye = "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm7 0a3 3 0 1 0 6 0 3 3 0 0 0-6 0";
icons.hidden = "m3 3 18 18M10 5h2c6 0 10 7 10 7a21 21 0 0 1-3 4M6 6a21 21 0 0 0-4 6s4 7 10 7h2";
icons.lock = "M6 10h12v11H6ZM8 10V6a4 4 0 0 1 8 0v4";
icons.unlock = "M6 10h12v11H6ZM8 10V6a4 4 0 0 1 8 0";
icons.snap = "M5 4v7a7 7 0 0 0 14 0V4h-4v7a3 3 0 0 1-6 0V4ZM5 7h4m6 0h4";
function Icon({ name }: { name: string }) { return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name] || icons.shape} /></svg>; }
function starPoints(w: number, h: number) { return Array.from({ length: 10 }, (_, index) => { const angle = -Math.PI / 2 + index * Math.PI / 5, radius = index % 2 ? 0.21 : 0.5; return `${w / 2 + Math.cos(angle) * w * radius},${h / 2 + Math.sin(angle) * h * radius}`; }).join(" "); }
function Shape({ item }: { item: OwnedCanvasItem }) {
  const strokeWidth = item.strokeWidth ?? 2, common = { strokeLinejoin: "round" as const, fill: item.fill ?? "#ede9fe", stroke: item.stroke ?? "#7c5cff", strokeWidth };
  const [start, end] = getOwnedLinePoints(item), marker = getOwnedArrowMarker(), markerId = `oc-arrow-${item.id.replace(/[^a-z0-9_-]/gi, "_")}`;
  return <svg width="100%" height="100%" viewBox={`0 0 ${item.w} ${item.h}`} overflow="visible" aria-hidden="true">{item.kind === "stroke" ? item.points?.length === 1 ? <circle cx={item.points[0]!.x} cy={item.points[0]!.y} r={strokeWidth / 2} fill={item.stroke ?? "#7c5cff"} /> : <polyline points={(item.points ?? []).map(p => `${p.x},${p.y}`).join(" ")} fill="none" stroke={item.stroke ?? "#7c5cff"} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" /> : item.shape === "line" || item.shape === "arrow" ? <><defs><marker id={markerId} viewBox={marker.viewBox} markerWidth={marker.markerWidth} markerHeight={marker.markerHeight} refX={marker.refX} refY={marker.refY} orient={marker.orient} markerUnits={marker.markerUnits}><path d={marker.path} fill={item.stroke ?? "#7c5cff"} /></marker></defs><line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke={item.stroke ?? "#7c5cff"} strokeWidth={strokeWidth} strokeLinecap="round" markerEnd={item.shape === "arrow" ? `url(#${markerId})` : undefined} /></> : item.shape === "ellipse" ? <ellipse cx={item.w / 2} cy={item.h / 2} rx={item.w / 2} ry={item.h / 2} {...common} /> : item.shape === "triangle" ? <polygon points={`${item.w / 2},0 ${item.w},${item.h} 0,${item.h}`} {...common} /> : item.shape === "star" ? <polygon points={starPoints(item.w, item.h)} {...common} /> : <rect width={item.w} height={item.h} {...common} />}</svg>;
}
const itemName = (item: OwnedCanvasItem) => item.kind === "text" ? item.text?.split("\n")[0]?.slice(0, 30) || "文字" : item.shape === "line" ? "直线" : item.shape === "arrow" ? "箭头" : ({ image: "图片", shape: "图形", stroke: "笔迹", frame: "画框" }[item.kind]);
const inputTarget = (target: EventTarget | null) => target instanceof HTMLElement && Boolean(target.closest("input,textarea,select,[contenteditable=true]"));
function pointSegmentDistance(point: Point, a: Point, b: Point) { const length = (b.x - a.x) ** 2 + (b.y - a.y) ** 2, t = length ? clamp(((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / length, 0, 1) : 0; return Math.hypot(point.x - a.x - t * (b.x - a.x), point.y - a.y - t * (b.y - a.y)); }
function withinFrame(item: OwnedCanvasItem, frame: OwnedCanvasItem) { return corners(item).every(p => { const local = rotate({ x: p.x - frame.x, y: p.y - frame.y }, -frame.rotation); return local.x >= -0.01 && local.y >= -0.01 && local.x <= frame.w + 0.01 && local.y <= frame.h + 0.01; }); }
function CanvasImage({ item }: { item: OwnedCanvasItem }) { const image = getOwnedImageLayout(item); return <svg className="oc-image-content" width="100%" height="100%" viewBox={`0 0 ${item.w} ${item.h}`} overflow="hidden" aria-hidden="true"><g transform={image.flipTransform}><image href={item.url} x={image.x} y={image.y} width={image.w} height={image.h} preserveAspectRatio="none" onError={event => { event.currentTarget.closest(".oc-item")?.setAttribute("data-image-error", "true"); }} onLoad={event => { event.currentTarget.closest(".oc-item")?.removeAttribute("data-image-error"); }} /></g></svg>; }
function CanvasText({ item }: { item: OwnedCanvasItem }) { const layout = getOwnedTextLayout(item); return <svg width="100%" height="100%" viewBox={`0 0 ${item.w} ${item.h}`} aria-hidden="true"><text fontFamily={layout.fontFamily} fontSize={layout.fontSize} fontWeight={layout.fontWeight} fontStyle={layout.fontStyle} textAnchor={layout.anchor} fill={item.fill ?? "#202027"} xmlSpace="preserve">{layout.lines.map((line, index) => <tspan key={index} x={line.x} y={line.y}>{line.text}</tspan>)}</text></svg>; }
function textStyle(item: OwnedCanvasItem) { const layout = getOwnedTextLayout(item); return { color: item.fill ?? "#202027", fontFamily: layout.fontFamily, fontSize: layout.fontSize, fontWeight: layout.fontWeight, fontStyle: layout.fontStyle, textAlign: layout.textAlign, lineHeight: layout.lineHeight }; }

export function OwnedCanvas({ document: incoming, onChange, readOnly = false, onUploadFiles, onExport, onReplaceImage, onSelectionChange, clipboardScope }: OwnedCanvasProps) {
  const [view, setView] = useState(incoming), live = useRef(incoming), emitted = useRef<OwnedCanvasDocument | null>(null);
  const flagCache = useRef<{ items: OwnedCanvasItem[]; flags: ReturnType<typeof getSceneFlags> } | null>(null);
  function flagsFor(items: OwnedCanvasItem[] = live.current.items) { if (flagCache.current?.items !== items) flagCache.current = { items, flags: getSceneFlags(items) }; return flagCache.current.flags; }
  function selectable(item: OwnedCanvasItem) { const flags = flagsFor().get(item.id); return !flags?.hidden && !flags?.locked; }
  const callbacks = useRef({ onChange, onUploadFiles, onExport, onReplaceImage, onSelectionChange }); callbacks.current = { onChange, onUploadFiles, onExport, onReplaceImage, onSelectionChange };
  const root = useRef<HTMLDivElement>(null), uploader = useRef<HTMLInputElement>(null), replacement = useRef<HTMLInputElement>(null), replacingId = useRef<string | null>(null), editor = useRef<HTMLTextAreaElement>(null);
  const [selected, setSelected] = useState<string[]>([]), selectedRef = useRef<string[]>([]);
  const [tool, setTool] = useState<Tool>("select"), [shape, setShape] = useState<NonNullable<OwnedCanvasItem["shape"]>>("rect"), [color, setColor] = useState("#7c5cff"), [lineWidth, setLineWidth] = useState(3);
  const [marquee, setMarquee] = useState<Bounds | null>(null), [editing, setEditing] = useState<string | null>(null), [text, setText] = useState("");
  const editBefore = useRef<OwnedCanvasDocument | null>(null), editingRef = useRef<string | null>(null), composing = useRef(false), finishRequested = useRef(false);
  const [layers, setLayers] = useState(false), [exportMenu, setExportMenu] = useState(false), [status, setStatus] = useState("");
  const [menu, setMenu] = useState<Point | null>(null), [typeMenu, setTypeMenu] = useState(false), [snap, setSnap] = useState(true), [guides, setGuides] = useState<{ axis: "x" | "y"; value: number }[]>([]);
  const [cropDraft, setCropDraft] = useState<{ id: string; url: string | undefined; crop: Crop } | null>(null), [eraserPoint, setEraserPoint] = useState<Point | null>(null), [eraserSize, setEraserSize] = useState(18);
  const clipboard = useRef<ObjectClipboard | null>(null), scopeRef = useRef(clipboardScope), layerDrag = useRef<string[] | null>(null), [layerDrop, setLayerDrop] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [historyVersion, setHistoryVersion] = useState(0), [spaceDown, setSpaceDown] = useState(false);
  const history = useRef<CanvasEdit[]>([]), future = useRef<CanvasEdit[]>([]), gesture = useRef<Gesture | null>(null), space = useRef(false);
  const lastTap = useRef({ id: "", time: 0, x: 0, y: 0 }), wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locked = readOnly || view.warnings.length > 0, lockedRef = useRef(locked); lockedRef.current = locked;
  const updateView = useCallback((next: OwnedCanvasDocument) => { live.current = next; setView(next); }, []);
  const choose = useCallback((ids: string[]) => { const items = live.current.items, eligible = items.filter(selectable), groups = new Set(eligible.filter(item => ids.includes(item.id)).map(item => item.groupId).filter(Boolean)); const next = eligible.filter(item => ids.includes(item.id) || item.groupId && groups.has(item.groupId)).map(item => item.id); selectedRef.current = next; setSelected(next); callbacks.current.onSelectionChange?.(next); }, []);
  const emit = useCallback((next: OwnedCanvasDocument) => { updateView(next); emitted.current = next; callbacks.current.onChange(next); }, [updateView]);
  const complete = useCallback((before: OwnedCanvasDocument, next: OwnedCanvasDocument) => {
    if (lockedRef.current) return;
    const edit = createEdit(before, next);
    if (edit) { history.current = [...history.current.slice(-(HISTORY_LIMIT - 1)), edit]; future.current = []; setHistoryVersion(v => v + 1); emit(next); }
    else updateView(next);
  }, [emit, updateView]);

  useEffect(() => {
    if (incoming === emitted.current && scopeRef.current === clipboardScope) return;
    const samePage = scopeRef.current === clipboardScope && incoming.pageId === live.current.pageId;
    if (!samePage) { gesture.current = null; history.current = []; future.current = []; clipboard.current = null; choose([]); setEditing(null); editingRef.current = null; setCropDraft(null); setMenu(null); setHistoryVersion(v => v + 1); }
    if (samePage && !lockedRef.current) {
      const previousIds = new Set(live.current.items.map(item => item.id)), added = incoming.items.filter(item => !previousIds.has(item.id));
      if (added.length) {
        // An upload/generation callback owns its persistence; record its new
        // IDs as one reversible insertion without replaying onChange on receipt.
        // A full-scene insertion may also hide its retained source (AI layers).
        // Capture both changes so one undo restores the original image too.
        const edit = createEdit(live.current, incoming);
        if (edit) { history.current = [...history.current.slice(-(HISTORY_LIMIT - 1)), edit]; future.current = []; setHistoryVersion(v => v + 1); }
      }
    }
    const active = gesture.current;
    if (active && incoming.pageId === live.current.pageId) {
      const touched = new Set([...active.originals.map(item => item.id), ...(active.id ? [active.id] : [])]);
      const drafts = new Map(live.current.items.filter(item => touched.has(item.id)).map(item => [item.id, item]));
      const existingIds = new Set(incoming.items.map(item => item.id));
      updateView({ ...incoming, items: [...incoming.items.map(item => drafts.get(item.id) ?? item), ...[...drafts.values()].filter(item => !existingIds.has(item.id))], camera: live.current.camera });
    } else updateView(incoming);
    const existing = new Set(live.current.items.filter(selectable).map(item => item.id));
    if (selectedRef.current.some(id => !existing.has(id))) choose(selectedRef.current.filter(id => existing.has(id)));
    if (editingRef.current && !existing.has(editingRef.current)) { editingRef.current = null; editBefore.current = null; setEditing(null); }
  }, [incoming, clipboardScope, choose, updateView]);
  useEffect(() => { if (scopeRef.current !== clipboardScope) { scopeRef.current = clipboardScope; clipboard.current = null; history.current = []; future.current = []; gesture.current = null; setCropDraft(null); setMenu(null); choose([]); setHistoryVersion(v => v + 1); } }, [clipboardScope, choose]);
  useEffect(() => {
    if (!locked) return;
    const active = gesture.current; if (active) { gesture.current = null; updateView(restoreGesture(active)); setMarquee(null); setGuides([]); if (root.current?.hasPointerCapture(active.pointerId)) root.current.releasePointerCapture(active.pointerId); }
    editingRef.current = null; editBefore.current = null; composing.current = false; setEditing(null); setCropDraft(null); setTypeMenu(false);
  }, [locked, updateView]);

  function screenPoint(clientX: number, clientY: number): Point { const rect = root.current!.getBoundingClientRect(); return { x: clientX - rect.left, y: clientY - rect.top }; }
  function worldPoint(clientX: number, clientY: number): Point { const p = screenPoint(clientX, clientY), camera = live.current.camera; return { x: (p.x - camera.x) / camera.zoom, y: (p.y - camera.y) / camera.zoom }; }
  function transformItems(items: OwnedCanvasItem[]) { const changed = new Map(items.map(item => [item.id, item])); updateView({ ...live.current, items: live.current.items.map(item => changed.get(item.id) ?? item) }); }
  function transformSelection(ids = selectedRef.current): OwnedCanvasItem[] {
    const expanded = new Set(expandSelection(live.current.items, ids)), items = live.current.items.filter(item => expanded.has(item.id));
    if (items.some(item => flagsFor().get(item.id)?.locked)) { setStatus("组或画框中包含锁定元素，请先在图层中解锁"); return []; }
    return items;
  }
  function newItem(kind: OwnedCanvasItem["kind"], point: Point): OwnedCanvasItem { return { id: `shape:${crypto.randomUUID()}`, kind, x: point.x, y: point.y, w: 1, h: 1, rotation: 0, opacity: 1, fill: kind === "text" ? color : "#ede9fe", stroke: color, strokeWidth: lineWidth, ...(kind === "shape" ? { shape } : {}), ...(kind === "frame" ? { fill: "#ffffff" } : {}) }; }
  function capture(event: ReactPointerEvent, active: Gesture) { gesture.current = active; root.current?.setPointerCapture(event.pointerId); }
  function startText(item: OwnedCanvasItem) { if (lockedRef.current || !selectable(item) || cropDraft) return; editBefore.current = live.current; editingRef.current = item.id; finishRequested.current = false; setEditing(item.id); setText(item.text ?? ""); choose([item.id]); }
  const finishText = useCallback(() => {
    if (composing.current) { finishRequested.current = true; return; }
    const id = editingRef.current, before = editBefore.current;
    if (!id || !before) return;
    const value = editor.current?.value ?? "";
    editingRef.current = null; editBefore.current = null; setEditing(null); composing.current = false; finishRequested.current = false;
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
    if (event.button !== 0 && event.button !== 1 || gesture.current || inputTarget(event.target) || cropDraft) return;
    setMenu(null); setTypeMenu(false); setExportMenu(false);
    if (wheelTimer.current) { clearTimeout(wheelTimer.current); wheelTimer.current = null; if (!lockedRef.current) emit(live.current); }
    root.current?.focus({ preventScroll: true });
    const point = worldPoint(event.clientX, event.clientY), screen = screenPoint(event.clientX, event.clientY), before = live.current;
    if (event.button === 1 || space.current || tool === "hand") { event.preventDefault(); capture(event, { type: "pan", start: point, screen, before, originals: [], pointerId: event.pointerId }); return; }
    if (!lockedRef.current && tool === "eraser") {
      event.preventDefault(); const active: Gesture = { type: "erase", start: point, screen, before, originals: [], pointerId: event.pointerId, erased: [] };
      capture(event, active); eraseAt(point, active); return;
    }
    if (!lockedRef.current && tool === "text") {
      const item = { ...newItem("text", point), w: 240, h: 72, text: "输入文字", fontSize: 24 };
      complete(before, { ...before, items: [...before.items, item] }); startText(item); setTool("select"); return;
    }
    if (!lockedRef.current && ["shape", "stroke", "frame"].includes(tool)) {
      event.preventDefault(); const item = newItem(tool as "shape" | "stroke" | "frame", point);
      const line = tool === "shape" && (shape === "line" || shape === "arrow");
      if (tool === "stroke") item.points = [{ x: 0, y: 0 }]; else if (line) item.points = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
      updateView({ ...before, items: [...before.items, item] }); choose([item.id]);
      capture(event, { type: "draw", start: point, screen, before, originals: [], pointerId: event.pointerId, id: item.id, points: tool === "stroke" ? [point] : undefined, line }); return;
    }
    const id = (event.target as Element).closest<HTMLElement>("[data-owned-id]")?.dataset.ownedId;
    const item = before.items.find(candidate => candidate.id === id && selectable(candidate));
    if (item) {
      const now = performance.now(), tap = lastTap.current;
      if (!lockedRef.current && item.kind === "text" && tap.id === item.id && now - tap.time < 350 && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) < 6) { lastTap.current.time = 0; startText(item); return; }
      lastTap.current = { id: item.id, time: now, x: event.clientX, y: event.clientY };
      let ids = selectedRef.current;
      if (event.shiftKey) { ids = ids.includes(item.id) ? ids.filter(value => value !== item.id && (!item.groupId || before.items.find(candidate => candidate.id === value)?.groupId !== item.groupId)) : [...ids, item.id]; choose(ids); ids = selectedRef.current; }
      else if (!ids.includes(item.id)) { ids = [item.id]; choose(ids); }
      if (!lockedRef.current && selectedRef.current.includes(item.id)) { const originals = transformSelection(); if (originals.length) capture(event, { type: "move", start: point, screen, before, originals, pointerId: event.pointerId }); }
      event.preventDefault(); return;
    }
    lastTap.current.time = 0; if (!event.shiftKey) choose([]);
    capture(event, { type: "marquee", start: point, screen, before, originals: [], pointerId: event.pointerId, additive: event.shiftKey ? selectedRef.current : [] });
    setMarquee({ ...point, w: 0, h: 0 }); event.preventDefault();
  }
  function startTransform(event: ReactPointerEvent, type: "resize" | "rotate", corner?: Corner) {
    event.stopPropagation(); event.preventDefault(); if (lockedRef.current) return;
    if (wheelTimer.current) { clearTimeout(wheelTimer.current); wheelTimer.current = null; emit(live.current); }
    if (cropDraft) return;
    const items = transformSelection(), box = bounds(items); if (!box) return;
    const point = worldPoint(event.clientX, event.clientY), pivot = items.length === 1 ? itemCenter(items[0]!) : center(box);
    capture(event, { type, corner, start: point, screen: screenPoint(event.clientX, event.clientY), before: live.current, originals: items, pointerId: event.pointerId, box, pivot, angle: Math.atan2(point.y - pivot.y, point.x - pivot.x) });
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (tool === "eraser") setEraserPoint(screenPoint(event.clientX, event.clientY));
    const active = gesture.current; if (!active || active.pointerId !== event.pointerId) return;
    const point = worldPoint(event.clientX, event.clientY), screen = screenPoint(event.clientX, event.clientY), dx = point.x - active.start.x, dy = point.y - active.start.y;
    if (Math.hypot(screen.x - active.screen.x, screen.y - active.screen.y) > 2) active.moved = true;
    if (active.type === "pan") updateView({ ...live.current, camera: { ...active.before.camera, x: active.before.camera.x + screen.x - active.screen.x, y: active.before.camera.y + screen.y - active.screen.y } });
    else if (active.type === "marquee") { const box = boxBetween(active.start, point); setMarquee(box); choose([...new Set([...(active.additive ?? []), ...live.current.items.filter(item => selectable(item) && intersects(box, bounds([item])!)).map(item => item.id)])]); }
    else if (!lockedRef.current && active.type === "erase") eraseAt(point, active);
    else if (!lockedRef.current && active.type === "move" && active.moved) { const result = snap && !event.altKey ? getMoveSnap(active.before.items, active.originals.map(item => item.id), { x: dx, y: dy }, { grid: 24, threshold: 6 / live.current.camera.zoom }) : { delta: { x: dx, y: dy }, guides: [] }; setGuides(result.guides); transformItems(active.originals.map(item => ({ ...item, x: item.x + result.delta.x, y: item.y + result.delta.y }))); }
    else if (!lockedRef.current && active.type === "resize") transformItems(active.originals.length === 1 ? [resize(active.originals[0]!, active.corner!, point, active.originals[0]!.kind === "image" || event.shiftKey)] : resizeMany(active.originals, active.box!, active.corner!, point));
    else if (!lockedRef.current && active.type === "rotate") {
      let angle = Math.atan2(point.y - active.pivot!.y, point.x - active.pivot!.x) - active.angle!; if (event.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * Math.PI / 12;
      transformItems(active.originals.map(item => { const oldCenter = itemCenter(item), moved = rotate({ x: oldCenter.x - active.pivot!.x, y: oldCenter.y - active.pivot!.y }, angle), rotation = item.rotation + angle, offset = rotate({ x: item.w / 2, y: item.h / 2 }, rotation); return { ...item, rotation, x: active.pivot!.x + moved.x - offset.x, y: active.pivot!.y + moved.y - offset.y }; }));
    } else if (!lockedRef.current && active.type === "draw") {
      const item = live.current.items.find(item => item.id === active.id); if (!item) return;
      if (active.points) {
        const last = active.points[active.points.length - 1]!; if (Math.hypot(point.x - last.x, point.y - last.y) < 0.8 / live.current.camera.zoom || active.points.length >= 4000) return;
        active.points.push(point); const xs = active.points.map(p => p.x), ys = active.points.map(p => p.y), x = Math.min(...xs), y = Math.min(...ys);
        transformItems([{ ...item, x, y, w: Math.max(1, Math.max(...xs) - x), h: Math.max(1, Math.max(...ys) - y), points: active.points.map(p => ({ x: p.x - x, y: p.y - y })) }]);
      } else if (active.line) { let end = point; if (event.shiftKey) { const length = Math.hypot(dx, dy), angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4; end = { x: active.start.x + Math.cos(angle) * length, y: active.start.y + Math.sin(angle) * length }; } const box = boxBetween(active.start, end); transformItems([{ ...item, ...box, w: Math.max(1, box.w), h: Math.max(1, box.h), points: [active.start, end].map(p => ({ x: p.x - box.x, y: p.y - box.y })) }]); }
      else { let box = boxBetween(active.start, point); if (event.shiftKey) { const size = Math.max(box.w, box.h); box = { x: dx < 0 ? active.start.x - size : active.start.x, y: dy < 0 ? active.start.y - size : active.start.y, w: size, h: size }; } transformItems([{ ...item, ...box, w: Math.max(1, box.w), h: Math.max(1, box.h) }]); }
    }
  }
  function eraseAt(point: Point, active: Gesture) {
    if (lockedRef.current) return;
    const radius = eraserSize / live.current.camera.zoom, erased = new Set(active.erased ?? []);
    for (const item of live.current.items) {
      if (item.kind !== "stroke" || !selectable(item) || !item.points?.length || !transformSelection([item.id]).length) continue;
      const local = rotate({ x: point.x - item.x, y: point.y - item.y }, -item.rotation), threshold = radius + (item.strokeWidth ?? 3) / 2;
      const hit = item.points.length === 1 ? Math.hypot(local.x - item.points[0]!.x, local.y - item.points[0]!.y) <= threshold : item.points.slice(1).some((p, index) => pointSegmentDistance(local, item.points![index]!, p) <= threshold);
      if (hit) { erased.add(item.id); active.originals.push(item); }
    }
    active.erased = [...erased];
    if (erased.size) {
      const items = live.current.items.filter(item => !erased.has(item.id)), counts = new Map<string, number>(); for (const item of items) if (item.groupId) counts.set(item.groupId, (counts.get(item.groupId) ?? 0) + 1);
      const originalIds = new Set(active.originals.map(item => item.id)), next = items.map(item => { if (!item.groupId || counts.get(item.groupId)! > 1) return item; if (!originalIds.has(item.id)) active.originals.push(item); return { ...item, groupId: undefined }; });
      updateView({ ...live.current, items: next }); choose(selectedRef.current.filter(id => !erased.has(id)));
    }
  }
  function restoreGesture(active: Gesture) {
    const touched = new Set([...active.originals.map(item => item.id), ...(active.id ? [active.id] : [])]);
    const items = live.current.items.filter(item => !touched.has(item.id)).concat(active.originals), map = new Map(items.map(item => [item.id, item])), order = active.before.items.map(item => item.id);
    return { ...live.current, camera: active.type === "pan" ? active.before.camera : live.current.camera, items: [...order.flatMap(id => map.has(id) ? [map.get(id)!] : []), ...items.filter(item => !order.includes(item.id))] };
  }
  function cancelGesture() { const active = gesture.current; if (!active) return; gesture.current = null; setMarquee(null); setGuides([]); updateView(restoreGesture(active)); choose(selectedRef.current); if (root.current?.hasPointerCapture(active.pointerId)) root.current.releasePointerCapture(active.pointerId); }
  function frameAttachments(items: OwnedCanvasItem[], ids: string[]) {
    let next = items;
    const flags = flagsFor(items), movedFrames = new Set(items.filter(item => item.kind === "frame" && ids.includes(item.id)).map(item => item.id)), frames = items.filter(item => item.kind === "frame" && !flags.get(item.id)?.hidden && !flags.get(item.id)?.locked && !ids.includes(item.id)).sort((a, b) => a.w * a.h - b.w * b.h), handled = new Set<string>();
    for (const id of ids) {
      const item = next.find(item => item.id === id); if (!item || item.kind === "frame" || handled.has(id) || item.frameId && movedFrames.has(item.frameId)) continue;
      const memberIds = item.groupId ? next.filter(value => value.groupId === item.groupId).map(value => value.id) : [id], members = next.filter(value => memberIds.includes(value.id));
      memberIds.forEach(value => handled.add(value));
      const frame = frames.find(frame => members.every(member => withinFrame(member, frame)));
      next = attachItemsToFrame(next, memberIds, frame?.id ?? null);
    }
    return frameBackgrounds(next);
  }
  function frameBackgrounds(items: OwnedCanvasItem[]) { const next = [...items]; for (const frame of items.filter(item => item.kind === "frame")) { const firstChild = next.findIndex(item => item.frameId === frame.id), frameIndex = next.findIndex(item => item.id === frame.id); if (firstChild >= 0 && frameIndex > firstChild) { next.splice(frameIndex, 1); next.splice(firstChild, 0, frame); } } return next; }
  function endGesture(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    const active = gesture.current; if (!active || active.pointerId !== event.pointerId) return;
    gesture.current = null; setMarquee(null); setGuides([]);
    if (cancel) {
      updateView(restoreGesture(active)); choose(selectedRef.current);
    }
    else if (active.type === "pan") { if (!lockedRef.current) emit(live.current); }
    else if (active.type !== "marquee" && !lockedRef.current) {
      if (active.type === "draw" && !active.moved) { const item = live.current.items.find(item => item.id === active.id)!; transformItems([{ ...item, w: active.points ? 1 : 180, h: active.points || active.line ? 1 : 120, ...(active.points ? { points: [{ x: 0, y: 0 }, { x: 0.1, y: 0.1 }] } : active.line ? { points: [{ x: 0, y: 0 }, { x: 180, y: 0 }] } : {}) }]); }
      // Compute the operation delta without treating asynchronously uploaded
      // objects as part of this gesture's undo transaction.
      const touched = new Set([...active.originals.map(item => item.id), ...(active.id ? [active.id] : [])]);
      const before = { ...live.current, items: live.current.items.filter(item => !touched.has(item.id)).concat(active.originals) };
      const originalOrder = active.before.items.map(item => item.id), orderMap = new Map(before.items.map(item => [item.id, item]));
      before.items = [...originalOrder.flatMap(id => orderMap.has(id) ? [orderMap.get(id)!] : []), ...before.items.filter(item => !originalOrder.includes(item.id))];
      let next = live.current;
      if (active.type === "move" && active.moved) { const ids = selectedRef.current.filter(id => active.originals.some(item => item.id === id)); next = { ...next, items: frameAttachments(next.items, ids) }; }
      if (active.type === "draw" && active.id) {
        const newItem = next.items.find(item => item.id === active.id);
        if (newItem?.kind === "frame") { const contained = next.items.filter(item => item.kind !== "frame" && selectable(item) && !item.frameId && withinFrame(item, newItem)); next = { ...next, items: frameBackgrounds(attachItemsToFrame(next.items, contained.map(item => item.id), newItem.id)) }; }
        else next = { ...next, items: frameAttachments(next.items, [active.id]) };
      }
      complete(before, next);
      if (active.type === "erase" && active.erased?.length) setStatus(`已擦除 ${active.erased.length} 条笔迹，可撤销`);
      if (active.type === "draw" && !active.points) setTool("select");
    }
    if (root.current?.hasPointerCapture(event.pointerId)) root.current.releasePointerCapture(event.pointerId);
  }
  function undo(redo = false) {
    if (lockedRef.current || gesture.current || editingRef.current || cropDraft) return;
    const from = redo ? future.current : history.current, to = redo ? history.current : future.current, edit = from.pop(); if (!edit) return;
    to.push(edit); const next = applyEdit(live.current, edit, redo ? "after" : "before"); emit(next); choose(selectedRef.current.filter(id => next.items.some(item => item.id === id))); setHistoryVersion(v => v + 1);
  }
  function modify(patch: Partial<OwnedCanvasItem>) { if (lockedRef.current || gesture.current || !transformSelection().length) return; const before = live.current; complete(before, { ...before, items: before.items.map(item => selectedRef.current.includes(item.id) && selectable(item) ? { ...item, ...patch } : item) }); }
  function remove() { if (lockedRef.current || cropDraft || !transformSelection().length) return; const before = live.current; complete(before, { ...before, items: deleteItems(before.items, selectedRef.current) }); choose([]); setMenu(null); }
  function layerMove(direction: "up" | "down" | "top" | "bottom") {
    if (lockedRef.current || !transformSelection().length) return; const before = live.current, order = { up: "forward", down: "backward", top: "front", bottom: "back" } as const;
    complete(before, { ...before, items: frameBackgrounds(reorderItems(before.items, selectedRef.current, order[direction])) }); setMenu(null);
  }
  function copyObjects(cut = false) {
    if (gesture.current || cropDraft || !selectedRef.current.length) return;
    const ids = expandSelection(live.current.items, selectedRef.current), items = live.current.items.filter(item => ids.includes(item.id));
    clipboard.current = { pageId: live.current.pageId, scope: scopeRef.current, items: structuredClone(items), ids, count: 0 };
    setStatus(`已复制 ${items.filter(item => !item.hidden).length} 个元素，粘贴仅在当前项目内生效`); if (cut && !lockedRef.current) remove(); setMenu(null);
  }
  function pasteObjects(point?: Point) {
    const saved = clipboard.current; if (lockedRef.current || gesture.current || cropDraft || !saved || saved.pageId !== live.current.pageId || saved.scope !== scopeRef.current) return;
    saved.count += 1; const before = live.current, box = bounds(saved.items), offset = point && box ? { x: point.x - box.x, y: point.y - box.y } : { x: saved.count * 24, y: saved.count * 24 };
    // Clipboard snapshots may have been deleted or pasted many times. Use fresh
    // temporary source IDs against the CURRENT scene so clone IDs never collide.
    const idMap = new Map(saved.items.map(item => [item.id, `shape:clipboard_${crypto.randomUUID()}`])), groupMap = new Map<string, string>();
    for (const item of saved.items) if (item.groupId && !groupMap.has(item.groupId)) groupMap.set(item.groupId, `group:clipboard_${crypto.randomUUID()}`);
    const source = saved.items.map(item => ({ ...item, id: idMap.get(item.id)!, ...(item.groupId ? { groupId: groupMap.get(item.groupId) } : {}), ...(item.frameId ? { frameId: idMap.get(item.frameId) ?? (before.items.some(frame => frame.id === item.frameId && frame.kind === "frame") ? item.frameId : undefined) } : {}) }));
    const result = duplicateItems([...before.items, ...source], source.map(item => item.id), offset), cloneIds = new Set(result.selectedIds), copies = result.items.filter(item => cloneIds.has(item.id));
    complete(before, { ...before, items: frameAttachments([...before.items, ...copies], result.selectedIds) }); choose(result.selectedIds); setTool("select"); setMenu(null); setStatus(`已粘贴 ${copies.filter(item => !item.hidden).length} 个元素`);
  }
  function duplicate() { if (lockedRef.current || cropDraft || !transformSelection().length) return; const before = live.current, result = duplicateItems(before.items, selectedRef.current); complete(before, { ...before, items: frameAttachments(result.items, result.selectedIds) }); choose(result.selectedIds); setMenu(null); }
  function group(ungroup = false) { if (lockedRef.current || cropDraft || !transformSelection().length) return; const before = live.current; try { if (ungroup) complete(before, { ...before, items: ungroupItems(before.items, selectedRef.current) }); else { const result = groupItems(before.items, selectedRef.current); complete(before, { ...before, items: result.items }); choose(result.selectedIds); } } catch (error) { setStatus(error instanceof Error ? error.message : "这些元素暂不能组合"); } setMenu(null); }
  function align(alignment: Parameters<typeof alignItems>[2]) { if (lockedRef.current || !transformSelection().length) return; const before = live.current; complete(before, { ...before, items: alignItems(before.items, selectedRef.current, alignment) }); setMenu(null); }
  function distribute(axis: "horizontal" | "vertical") { if (lockedRef.current || !transformSelection().length) return; const before = live.current; complete(before, { ...before, items: distributeItems(before.items, selectedRef.current, axis) }); setMenu(null); }
  function nudge(delta: Point) { if (lockedRef.current || cropDraft || !transformSelection().length) return; const before = live.current, changes = new Map(transformSelection().map(item => [item.id, { ...item, x: item.x + delta.x, y: item.y + delta.y }])); complete(before, { ...before, items: frameAttachments(before.items.map(item => changes.get(item.id) ?? item), selectedRef.current) }); }
  function layerToggle(id: string, key: "hidden" | "locked") { if (lockedRef.current || gesture.current || cropDraft) return; const before = live.current; complete(before, { ...before, items: before.items.map(item => item.id === id ? { ...item, [key]: !item[key] } : item) }); choose(selectedRef.current); }
  function dropLayer(targetId: string) { const ids = layerDrag.current; layerDrag.current = null; setLayerDrop(null); if (lockedRef.current || !ids?.length || ids.includes(targetId) || !transformSelection(ids).length) return; const before = live.current, set = new Set(expandSelection(before.items, ids)), moved = before.items.filter(item => set.has(item.id)), rest = before.items.filter(item => !set.has(item.id)), index = rest.findIndex(item => item.id === targetId); if (index < 0) return; rest.splice(index + 1, 0, ...moved); complete(before, { ...before, items: frameBackgrounds(rest) }); choose(ids); }
  function beginCrop(item: OwnedCanvasItem) { if (lockedRef.current || gesture.current || !selectable(item)) return; setCropDraft({ id: item.id, url: item.url, crop: { ...(item.crop ?? { x: 0, y: 0, w: 1, h: 1 }) } }); setTypeMenu(false); setMenu(null); }
  function changeCrop(key: keyof Crop, percent: number) { if (!Number.isFinite(percent)) return; setCropDraft(old => { if (!old) return old; const next = { ...old.crop, [key]: percent / 100 }; next.w = clamp(next.w, 0.01, 1); next.h = clamp(next.h, 0.01, 1); next.x = clamp(next.x, 0, 1 - next.w); next.y = clamp(next.y, 0, 1 - next.h); return { ...old, crop: next }; }); }
  function applyCrop() { const draft = cropDraft; if (!draft || lockedRef.current) return; const before = live.current, target = before.items.find(item => item.id === draft.id); if (!target || !selectable(target) || target.url !== draft.url) { setCropDraft(null); setStatus("图片已经变化，请重新进入裁切"); return; } complete(before, { ...before, items: before.items.map(item => item.id === draft.id ? { ...item, crop: { ...draft.crop } } : item) }); setCropDraft(null); setStatus("已应用裁切，可撤销；AI整图改图前需重置裁切"); }
  async function replaceImage(id: string, files: File[]) {
    if (lockedRef.current || !callbacks.current.onReplaceImage || !files.length) return; const scope = scopeRef.current, page = live.current.pageId; setBusy(true); setStatus("正在提交替换图片…");
    try { const identity = await callbacks.current.onReplaceImage(id, files); const before = live.current, item = before.items.find(item => item.id === id); if (!identity) { setStatus("替换图片仍在任务中，原图已保留；完成后可从素材面板重试替换"); return; } if (lockedRef.current || scope !== scopeRef.current || page !== before.pageId || !item || !selectable(item)) { setStatus("目标已变化，替换图片已保留在素材中"); return; } complete(before, { ...before, items: before.items.map(item => item.id === id ? { ...item, ...identity, crop: undefined, flipX: false, flipY: false } : item) }); setStatus("图片已替换，可撤销"); }
    catch (error) { setStatus(error instanceof Error ? error.message.slice(0, 240) : "替换未完成，原图已保留"); } finally { setBusy(false); }
  }
  function zoomAt(zoom: number, point?: Point) {
    const rect = root.current?.getBoundingClientRect(); if (!rect) return;
    const p = point ?? { x: rect.width / 2, y: rect.height / 2 }, old = live.current.camera, nextZoom = clamp(zoom, 0.1, 4);
    updateView({ ...live.current, camera: { zoom: nextZoom, x: p.x - (p.x - old.x) * nextZoom / old.zoom, y: p.y - (p.y - old.y) * nextZoom / old.zoom } });
  }
  function persistCamera() { if (!lockedRef.current) emit(live.current); }
  function fit() { const flags = flagsFor(), box = bounds(live.current.items.filter(item => !flags.get(item.id)?.hidden)), rect = root.current?.getBoundingClientRect(); if (!rect) return; if (!box) updateView({ ...live.current, camera: { x: rect.width / 2, y: rect.height / 2, zoom: 1 } }); else { const zoom = clamp(Math.min((rect.width - 120) / Math.max(1, box.w), (rect.height - 180) / Math.max(1, box.h)), 0.1, 2); updateView({ ...live.current, camera: { zoom, x: rect.width / 2 - (box.x + box.w / 2) * zoom, y: rect.height / 2 - (box.y + box.h / 2) * zoom } }); } persistCamera(); }
  useEffect(() => {
    const element = root.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as Element).closest("[data-owned-ui]")) return; event.preventDefault(); if (gesture.current) return;
      if (event.ctrlKey || event.metaKey) { const rect = element.getBoundingClientRect(), p = { x: event.clientX - rect.left, y: event.clientY - rect.top }, old = live.current.camera, zoom = clamp(old.zoom * Math.exp(-event.deltaY * 0.002), 0.1, 4); updateView({ ...live.current, camera: { zoom, x: p.x - (p.x - old.x) * zoom / old.zoom, y: p.y - (p.y - old.y) * zoom / old.zoom } }); }
      else { const camera = live.current.camera, unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1; updateView({ ...live.current, camera: { ...camera, x: camera.x - event.deltaX * unit, y: camera.y - event.deltaY * unit } }); }
      if (wheelTimer.current) clearTimeout(wheelTimer.current); wheelTimer.current = setTimeout(() => { if (!lockedRef.current) emit(live.current); }, 180);
    };
    const release = () => { space.current = false; setSpaceDown(false); const active = gesture.current; if (active) { gesture.current = null; setGuides([]); setMarquee(null); updateView(restoreGesture(active)); if (element.hasPointerCapture(active.pointerId)) element.releasePointerCapture(active.pointerId); } };
    element.addEventListener("wheel", wheel, { passive: false }); window.addEventListener("blur", release);
    return () => { element.removeEventListener("wheel", wheel); window.removeEventListener("blur", release); if (wheelTimer.current) clearTimeout(wheelTimer.current); };
  }, [emit, updateView]);
  async function upload(files: File[], point?: Point) { if (lockedRef.current || !callbacks.current.onUploadFiles || !files.length) return; setBusy(true); setStatus("正在提交图片…"); try { await callbacks.current.onUploadFiles(files, point); setStatus("上传进度见任务面板"); } catch { setStatus("图片未能加入，请保留原图后重试"); } finally { setBusy(false); } }
  async function exportDocument(format: "png" | "svg", scope?: { itemIds?: string[]; frameId?: string }) { if (!callbacks.current.onExport || cropDraft || gesture.current || editingRef.current) return; setExportMenu(false); setMenu(null); setBusy(true); setStatus("正在准备导出…"); try { await callbacks.current.onExport(format, scope); setStatus("已完成导出"); } catch (error) { setStatus(error instanceof Error ? error.message.slice(0, 240) : "导出未完成，请重试"); } finally { setBusy(false); } }
  const chosen = view.items.filter(item => selected.includes(item.id) && selectable(item)), selectionBox = bounds(chosen), single = chosen.length === 1 ? chosen[0] : null;
  const viewFlags = flagsFor(view.items), selectedExpanded = new Set(expandSelection(view.items, selected));
  const blockedSelection = view.items.some(item => selectedExpanded.has(item.id) && viewFlags.get(item.id)?.locked);
  const canMutate = !locked && !blockedSelection && chosen.length > 0 && !cropDraft && !editing;
  const selectionCorners = single ? corners(single) : selectionBox ? [{ x: selectionBox.x, y: selectionBox.y }, { x: selectionBox.x + selectionBox.w, y: selectionBox.y }, { x: selectionBox.x + selectionBox.w, y: selectionBox.y + selectionBox.h }, { x: selectionBox.x, y: selectionBox.y + selectionBox.h }] : [];
  const displayPoint = (point: Point) => ({ left: point.x * view.camera.zoom + view.camera.x, top: point.y * view.camera.zoom + view.camera.y });
  const stop = (event: ReactPointerEvent) => event.stopPropagation();
  void historyVersion;

  return <div ref={root} className={`oc-canvas ${tool === "hand" || spaceDown ? "oc-pan" : tool === "eraser" ? "oc-erase" : tool !== "select" ? "oc-create" : ""}`} data-testid="owned-canvas" tabIndex={0} aria-label="设计画布" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerLeave={() => setEraserPoint(null)} onPointerUp={event => endGesture(event)} onPointerCancel={event => endGesture(event, true)} onLostPointerCapture={event => { if (gesture.current) endGesture(event, true); }}
    onContextMenu={event => { if (inputTarget(event.target) || (event.target as Element).closest("[data-owned-ui]") || cropDraft || gesture.current) return; event.preventDefault(); const id = (event.target as Element).closest<HTMLElement>("[data-owned-id]")?.dataset.ownedId, item = live.current.items.find(item => item.id === id && selectable(item)); if (item && !selectedRef.current.includes(item.id)) choose([item.id]); else if (!item) choose([]); root.current?.focus({ preventScroll: true }); const p = screenPoint(event.clientX, event.clientY); setMenu({ x: clamp(p.x, 8, Math.max(8, (root.current?.clientWidth ?? 240) - 242)), y: clamp(p.y, 8, Math.max(8, (root.current?.clientHeight ?? 440) - 430)) }); setTypeMenu(false); setExportMenu(false); }}
    onDragOver={event => { if (!locked && onUploadFiles) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (!locked) void upload([...event.dataTransfer.files].filter(file => file.type.startsWith("image/")), worldPoint(event.clientX, event.clientY)); }}
    onCopy={event => { if (inputTarget(event.target) || composing.current || !selectedRef.current.length) return; event.preventDefault(); copyObjects(); }}
    onCut={event => { if (inputTarget(event.target) || composing.current || locked || !selectedRef.current.length) return; event.preventDefault(); copyObjects(true); }}
    onPaste={event => { if (inputTarget(event.target) || composing.current || locked || cropDraft) return; const files = [...event.clipboardData.files].filter(file => file.type.startsWith("image/")); if (files.length) { event.preventDefault(); void upload(files); } else if (clipboard.current) { event.preventDefault(); pasteObjects(); } }}
    onKeyUp={event => { if (event.code === "Space") { space.current = false; setSpaceDown(false); } }}
    onKeyDown={event => {
      if (inputTarget(event.target) || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.code === "Space") { event.preventDefault(); space.current = true; setSpaceDown(true); return; }
      const command = event.metaKey || event.ctrlKey, key = event.key.toLowerCase();
      if (command && key === "a") { event.preventDefault(); choose(live.current.items.map(item => item.id)); return; }
      if (event.key === "Escape") { event.preventDefault(); if (gesture.current) cancelGesture(); else if (cropDraft) setCropDraft(null); else if (menu || typeMenu || exportMenu) { setMenu(null); setTypeMenu(false); setExportMenu(false); } else { choose([]); setTool("select"); } return; }
      if (locked) return;
      if (cropDraft || gesture.current) return;
      if (command && key === "z") { event.preventDefault(); undo(event.shiftKey); }
      else if (command && key === "y") { event.preventDefault(); undo(true); }
      else if (command && key === "d") { event.preventDefault(); duplicate(); }
      else if (command && key === "g") { event.preventDefault(); group(event.shiftKey); }
      else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); remove(); }
      else if (event.key.startsWith("Arrow") && selectedRef.current.length) { event.preventDefault(); const step = event.shiftKey ? 10 : 1; nudge({ x: event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0, y: event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0 }); }
      else if (!command) { const tools: Record<string, Tool> = { v: "select", h: "hand", t: "text", p: "stroke", r: "shape", f: "frame", e: "eraser" }; if (tools[key]) setTool(tools[key]); }
    }}>
    <div className="oc-grid" style={{ backgroundSize: `${24 * view.camera.zoom}px ${24 * view.camera.zoom}px`, backgroundPosition: `${view.camera.x}px ${view.camera.y}px` }} />
    {!view.items.length && <div className="oc-empty"><span>从一个想法开始</span><small>{locked ? "当前画布为只读" : "拖入图片，或用下方工具开始创作"}</small></div>}
    <div className="oc-world" style={{ transform: `translate(${view.camera.x}px,${view.camera.y}px) scale(${view.camera.zoom})` }}>
      {view.items.filter(item => !viewFlags.get(item.id)?.hidden).map(item => <div key={item.id} data-testid="owned-canvas-item" data-owned-id={item.id} data-kind={item.kind} data-shape={item.shape} data-frame-id={item.frameId} data-group-id={item.groupId} data-locked={viewFlags.get(item.id)?.locked || undefined} data-selected={selected.includes(item.id) || undefined} className={`oc-item oc-${item.kind}`} aria-label={itemName(item)} style={{ left: item.x, top: item.y, width: item.w, height: item.h, transform: `rotate(${item.rotation}rad)`, opacity: item.opacity, pointerEvents: viewFlags.get(item.id)?.locked ? "none" : undefined }}>
        {item.kind === "image" ? <CanvasImage item={cropDraft?.id === item.id ? { ...item, crop: cropDraft.crop } : item} /> : item.kind === "text" ? editing === item.id ? <textarea ref={editor} className="oc-text-edit" data-owned-ui aria-label="编辑画布文字" value={text} style={textStyle(item)} onChange={event => setText(event.target.value)} onPointerDown={stop} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; if (finishRequested.current) setTimeout(finishText, 0); }} onBlur={finishText} onKeyDown={event => { event.stopPropagation(); if (!composing.current && !event.nativeEvent.isComposing && (event.key === "Escape" || event.key === "Enter" && (event.ctrlKey || event.metaKey))) { event.preventDefault(); finishText(); root.current?.focus(); } }} /> : <CanvasText item={item} /> : item.kind === "frame" ? <div className="oc-frame-fill"><Shape item={item} /><small>画框</small></div> : <Shape item={item} />}
      </div>)}
    </div>
    {selectionBox && !editing && !cropDraft && <div className="oc-selection"><svg className="oc-selection-lines" aria-hidden="true"><polygon points={selectionCorners.map(point => { const p = displayPoint(point); return `${p.left},${p.top}`; }).join(" ")} /></svg>{canMutate && <>{selectionCorners.map((point, index) => <button key={index} tabIndex={-1} aria-label={`调整${["左上", "右上", "右下", "左下"][index]}尺寸`} className={`oc-handle oc-handle-${["nw", "ne", "se", "sw"][index]}`} style={displayPoint(point)} onPointerDown={event => startTransform(event, "resize", ["nw", "ne", "se", "sw"][index] as Corner)} />)}<button tabIndex={-1} aria-label="旋转选中元素" className="oc-rotation" style={{ ...displayPoint({ x: (selectionCorners[0]!.x + selectionCorners[1]!.x) / 2, y: (selectionCorners[0]!.y + selectionCorners[1]!.y) / 2 }), marginTop: -32 }} onPointerDown={event => startTransform(event, "rotate")}><Icon name="rotate" /></button></>}</div>}
    {marquee && <div className="oc-marquee" style={{ ...displayPoint(marquee), width: marquee.w * view.camera.zoom, height: marquee.h * view.camera.zoom }} />}
    {guides.map((guide, index) => <div key={index} data-testid="owned-snap-guide" className={`oc-snap-guide oc-snap-${guide.axis}`} style={guide.axis === "x" ? { left: displayPoint({ x: guide.value, y: 0 }).left } : { top: displayPoint({ x: 0, y: guide.value }).top }} />)}
    {tool === "eraser" && eraserPoint && <div className="oc-eraser-cursor" style={{ left: eraserPoint.x, top: eraserPoint.y, width: eraserSize * 2, height: eraserSize * 2 }} />}
    <div className="oc-top-left" data-owned-ui onPointerDown={stop}><button aria-label="图层" aria-expanded={layers} onClick={() => setLayers(!layers)} className={layers ? "is-active" : ""}><Icon name="layers" /></button><button aria-label="吸附与对齐辅助线" aria-pressed={snap} title="吸附与对齐辅助线（拖动时按Alt临时关闭）" className={snap ? "oc-soft-active" : ""} onClick={() => setSnap(!snap)}><Icon name="snap" /></button>{locked && <span className="oc-readonly">只读</span>}</div>
    {layers && <aside className="oc-layers" data-owned-ui onPointerDown={stop} aria-label="画布图层">
      <strong>图层 <small>{view.items.length}</small></strong>{!view.items.length && <p>还没有元素</p>}
      {[...view.items].reverse().map(item => <div key={item.id} data-testid="owned-layer-row" data-layer-id={item.id} data-hidden={item.hidden || undefined} data-locked={item.locked || undefined} className={`oc-layer-row ${selected.includes(item.id) ? "is-active" : ""} ${layerDrop === item.id ? "is-drop-target" : ""}`} draggable={!locked && selectable(item) && !cropDraft} onDragStart={event => { if (locked || !selectable(item)) { event.preventDefault(); return; } const ids = selectedRef.current.includes(item.id) ? selectedRef.current : [item.id]; if (!transformSelection(ids).length) { event.preventDefault(); return; } layerDrag.current = ids; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("application/x-novart-layer", item.id); }} onDragOver={event => { if (layerDrag.current && !locked) { event.preventDefault(); event.stopPropagation(); setLayerDrop(item.id); event.dataTransfer.dropEffect = "move"; } }} onDrop={event => { if (layerDrag.current) { event.preventDefault(); event.stopPropagation(); dropLayer(item.id); } }} onDragEnd={() => { layerDrag.current = null; setLayerDrop(null); }}>
        <button className="oc-layer-select" aria-label={`选择图层 ${itemName(item)}`} disabled={!selectable(item)} onClick={event => choose(event.shiftKey ? selectedRef.current.includes(item.id) ? selectedRef.current.filter(id => id !== item.id && (!item.groupId || view.items.find(value => value.id === id)?.groupId !== item.groupId)) : [...selectedRef.current, item.id] : [item.id])}><Icon name={item.kind === "stroke" ? "stroke" : item.kind === "text" ? "text" : item.kind === "frame" ? "frame" : "shape"} /><span>{itemName(item)}{item.groupId && <small> · 组</small>}{item.frameId && <small> · 框内</small>}</span></button>
        <button className="oc-layer-state" aria-label={item.hidden ? "显示图层" : "隐藏图层"} title={item.hidden ? "显示图层" : "隐藏图层"} disabled={locked || !!cropDraft} onClick={() => layerToggle(item.id, "hidden")}><Icon name={item.hidden ? "hidden" : "eye"} /></button>
        <button className="oc-layer-state" aria-label={item.locked ? "解锁图层" : "锁定图层"} title={item.locked ? "解锁图层" : "锁定图层"} disabled={locked || !!cropDraft} onClick={() => layerToggle(item.id, "locked")}><Icon name={item.locked ? "lock" : "unlock"} /></button>
      </div>)}
      <p className="oc-layer-hint">拖动图层调整顺序 · 框内元素随画框移动</p>
    </aside>}
    {chosen.length > 0 && !locked && !editing && !cropDraft && <div className="oc-properties" data-owned-ui onPointerDown={stop} aria-label="选中元素属性">
      <span>{chosen.length === 1 ? itemName(chosen[0]!) : `${chosen.length} 个元素`}</span>
      {single?.kind !== "image" && <label title="颜色"><input disabled={!canMutate} type="color" aria-label="元素颜色" value={/^#[\da-f]{6}$/i.test((single?.kind === "stroke" || single?.shape === "line" || single?.shape === "arrow" ? single.stroke : single?.fill) ?? "") ? (single!.kind === "stroke" || single!.shape === "line" || single!.shape === "arrow" ? single!.stroke : single!.fill) : color} onChange={event => { setColor(event.target.value); modify(single?.kind === "stroke" || single?.shape === "line" || single?.shape === "arrow" ? { stroke: event.target.value } : { fill: event.target.value }); }} /></label>}
      {single?.kind === "text" && <><label>字号<input disabled={!canMutate} type="number" aria-label="文字字号" min="8" max="240" key={`${single.id}-${single.fontSize}`} defaultValue={single.fontSize ?? 24} onBlur={event => { const value = Number(event.target.value); if (Number.isFinite(value)) modify({ fontSize: clamp(value, 8, 240) }); }} /></label><button disabled={!canMutate} aria-label="文字加粗" aria-pressed={single.fontWeight === "bold"} className={single.fontWeight === "bold" ? "oc-soft-active" : ""} onClick={() => modify({ fontWeight: single.fontWeight === "bold" ? "normal" : "bold" })}><b>B</b></button><button disabled={!canMutate} aria-label="文字斜体" aria-pressed={single.fontStyle === "italic"} className={single.fontStyle === "italic" ? "oc-soft-active" : ""} onClick={() => modify({ fontStyle: single.fontStyle === "italic" ? "normal" : "italic" })}><em>I</em></button><button aria-label="文字排版" aria-expanded={typeMenu} disabled={!canMutate} onClick={() => { setTypeMenu(!typeMenu); setMenu(null); }}>排版</button></>}
      {(single?.kind === "stroke" || single?.shape === "line" || single?.shape === "arrow") && <label>粗细<input disabled={!canMutate} type="number" aria-label="笔迹粗细" min="1" max="80" key={`${single.id}-${single.strokeWidth}`} defaultValue={single.strokeWidth ?? 3} onBlur={event => { const value = Number(event.target.value); if (Number.isFinite(value)) modify({ strokeWidth: clamp(value, 1, 80) }); }} /></label>}
      {single?.kind === "image" && <button aria-label="裁切图片" disabled={!canMutate} onClick={() => beginCrop(single)}>裁切</button>}
      <label title="不透明度">透明度<input disabled={!canMutate} type="number" aria-label="不透明度" min="0" max="100" key={single ? `${single.id}-${single.opacity}` : selected.join()} defaultValue={Math.round((single?.opacity ?? 1) * 100)} onBlur={event => { const value = Number(event.target.value); if (Number.isFinite(value)) modify({ opacity: clamp(value / 100, 0, 1) }); }} /></label>
      <button aria-label="更多元素操作" aria-expanded={!!menu} onClick={() => { setMenu(menu ? null : { x: Math.max(8, (root.current?.clientWidth ?? 560) - 252), y: 66 }); setTypeMenu(false); }}><Icon name="more" /></button>
      <button disabled={!canMutate} aria-label="删除选中元素" title="删除" onClick={remove}><Icon name="trash" /></button>
    </div>}
    {typeMenu && single?.kind === "text" && canMutate && <div className="oc-type-menu" data-owned-ui onPointerDown={stop} aria-label="文字排版面板">
      <label>字体<select aria-label="文字字体" value={single.fontFamily ?? "sans"} onChange={event => modify({ fontFamily: event.target.value as OwnedCanvasItem["fontFamily"] })}><option value="sans">无衬线</option><option value="serif">衬线</option><option value="mono">等宽</option></select></label>
      <label>行距<input type="number" aria-label="文字行距" min="0.5" max="4" step="0.1" key={`${single.id}-${single.lineHeight}`} defaultValue={single.lineHeight ?? 1.2} onBlur={event => { const value = Number(event.target.value); if (Number.isFinite(value)) modify({ lineHeight: clamp(value, 0.5, 4) }); }} /></label>
      <div className="oc-segmented" aria-label="文字对齐">{([['left', '文字左对齐', '左'], ['center', '文字居中对齐', '中'], ['right', '文字右对齐', '右']] as const).map(([value, label, title]) => <button key={value} aria-label={label} aria-pressed={(single.textAlign ?? "left") === value} className={(single.textAlign ?? "left") === value ? "oc-soft-active" : ""} onClick={() => modify({ textAlign: value })}>{title}</button>)}</div>
    </div>}
    {menu && !cropDraft && <div className="oc-action-menu" data-testid="owned-object-menu" role="menu" aria-label="元素操作菜单" data-owned-ui onPointerDown={stop} style={{ left: menu.x, top: menu.y }}>
      <div className="oc-menu-section"><button role="menuitem" aria-label="复制元素" disabled={!chosen.length} onClick={() => copyObjects()}>复制<span>Ctrl+C</span></button><button role="menuitem" aria-label="剪切元素" disabled={!canMutate} onClick={() => copyObjects(true)}>剪切<span>Ctrl+X</span></button><button role="menuitem" aria-label="粘贴元素" disabled={locked || !clipboard.current} onClick={() => pasteObjects(worldPoint((root.current?.getBoundingClientRect().left ?? 0) + menu.x, (root.current?.getBoundingClientRect().top ?? 0) + menu.y))}>粘贴<span>Ctrl+V</span></button><button role="menuitem" aria-label="创建副本" disabled={!canMutate} onClick={duplicate}>创建副本<span>Ctrl+D</span></button></div>
      {single?.kind === "image" && <div className="oc-menu-section"><button role="menuitem" aria-label="裁切图片" disabled={!canMutate} onClick={() => beginCrop(single)}>裁切图片</button><button role="menuitem" aria-label="水平翻转图片" disabled={!canMutate} onClick={() => { modify({ flipX: !single.flipX }); setMenu(null); }}>水平翻转</button><button role="menuitem" aria-label="垂直翻转图片" disabled={!canMutate} onClick={() => { modify({ flipY: !single.flipY }); setMenu(null); }}>垂直翻转</button><button role="menuitem" aria-label="重置图片裁切" disabled={!canMutate || !single.crop} onClick={() => { modify({ crop: undefined }); setMenu(null); }}>重置裁切</button><button role="menuitem" aria-label="替换图片" disabled={!canMutate || busy || !onReplaceImage} onClick={() => { replacingId.current = single.id; replacement.current?.click(); setMenu(null); }}>替换图片…</button></div>}
      <div className="oc-menu-section"><button role="menuitem" aria-label="组合选中元素" disabled={!canMutate || chosen.length < 2} onClick={() => group()}>组合<span>Ctrl+G</span></button><button role="menuitem" aria-label="取消组合" disabled={!canMutate || !chosen.some(item => item.groupId)} onClick={() => group(true)}>取消组合<span>Ctrl+Shift+G</span></button></div>
      {chosen.length > 1 && <div className="oc-menu-section oc-menu-arrange"><small>对齐</small><div>{([['left', '左对齐'], ['center', '水平居中'], ['right', '右对齐'], ['top', '顶部对齐'], ['middle', '垂直居中'], ['bottom', '底部对齐']] as const).map(([value, label]) => <button key={value} role="menuitem" aria-label={`元素${label}`} disabled={!canMutate} onClick={() => align(value)}>{label}</button>)}</div><button role="menuitem" aria-label="水平等距分布" disabled={!canMutate || chosen.length < 3} onClick={() => distribute("horizontal")}>水平等距分布</button><button role="menuitem" aria-label="垂直等距分布" disabled={!canMutate || chosen.length < 3} onClick={() => distribute("vertical")}>垂直等距分布</button></div>}
      <div className="oc-menu-section oc-menu-order">{([['up', '上移一层'], ['down', '下移一层'], ['top', '置于顶层'], ['bottom', '置于底层']] as const).map(([value, label]) => <button key={value} role="menuitem" aria-label={label} disabled={!canMutate} onClick={() => layerMove(value)}>{label}</button>)}</div>
      {single?.frameId && <div className="oc-menu-section"><button role="menuitem" aria-label="移出画框" disabled={!canMutate} onClick={() => { const before = live.current; complete(before, { ...before, items: attachItemsToFrame(before.items, selectedRef.current, null) }); setMenu(null); }}>移出画框</button></div>}
      {single?.kind === "frame" && <div className="oc-menu-section"><button role="menuitem" aria-label="导出当前画框PNG" disabled={busy || !onExport} onClick={() => void exportDocument("png", { frameId: single.id })}>导出当前画框 PNG</button><button role="menuitem" aria-label="导出当前画框SVG" disabled={busy || !onExport} onClick={() => void exportDocument("svg", { frameId: single.id })}>导出当前画框 SVG</button></div>}
      <div className="oc-menu-section"><button role="menuitem" aria-label="删除选中元素" disabled={!canMutate} onClick={remove}>删除<span>Delete</span></button></div>
    </div>}
    {cropDraft && <div className="oc-crop-panel" data-testid="owned-crop-panel" role="dialog" aria-label="图片裁切面板" data-owned-ui onPointerDown={stop} onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); setCropDraft(null); root.current?.focus(); } }}>
      <div className="oc-crop-heading"><strong>裁切图片</strong><button aria-label="取消裁切" onClick={() => setCropDraft(null)}>×</button></div>
      <p>调整原图保留区域，画布实时预览。单位：原图百分比</p>
      <div className="oc-crop-preview"><img src={cropDraft.url} alt="裁切原图预览" draggable={false} /><div className="oc-crop-window" style={{ left: `${cropDraft.crop.x * 100}%`, top: `${cropDraft.crop.y * 100}%`, width: `${cropDraft.crop.w * 100}%`, height: `${cropDraft.crop.h * 100}%` }} /></div>
      <div className="oc-crop-fields">{([['x', '裁切左边距', '左边距'], ['y', '裁切上边距', '上边距'], ['w', '裁切宽度', '宽度'], ['h', '裁切高度', '高度']] as const).map(([key, label, title]) => <label key={key}>{title}<input type="number" aria-label={label} min={key === "w" || key === "h" ? "1" : "0"} max="100" step="1" value={Math.round(cropDraft.crop[key] * 10000) / 100} onChange={event => changeCrop(key, Number(event.target.value))} /><span>%</span></label>)}</div>
      <small>AI整图改图前请先重置裁切；裁切保留原始素材。</small>
      <div className="oc-crop-actions"><button aria-label="重置裁切区域" onClick={() => setCropDraft({ ...cropDraft, crop: { x: 0, y: 0, w: 1, h: 1 } })}>重置区域</button><button aria-label="取消裁切" onClick={() => setCropDraft(null)}>取消</button><button aria-label="应用裁切" className="is-active" disabled={locked} onClick={applyCrop}>应用裁切</button></div>
    </div>}
    <div className="oc-dock" data-owned-ui onPointerDown={stop} aria-label="画布工具"><button aria-label="选择" title="选择 V" className={tool === "select" ? "is-active" : ""} disabled={!!cropDraft} onClick={() => setTool("select")}><Icon name="select" /></button><button aria-label="移动画布" title="移动画布 H / 空格" className={tool === "hand" ? "is-active" : ""} disabled={!!cropDraft} onClick={() => setTool("hand")}><Icon name="hand" /></button><i />{([['text', '文字', 'T'], ['stroke', '画笔', 'P'], ['eraser', '橡皮擦', 'E'], ['shape', '图形', 'R'], ['frame', '画框', 'F']] as const).map(([value, label, key]) => <button key={value} aria-label={label} title={`${label} ${key}`} disabled={locked || !!cropDraft} className={tool === value ? "is-active" : ""} onClick={() => setTool(value)}><Icon name={value} /></button>)}<button aria-label="上传图片" title="上传图片" disabled={locked || busy || !onUploadFiles || !!cropDraft} onClick={() => uploader.current?.click()}><Icon name="upload" /></button><i /><button aria-label="撤销" title="撤销 Ctrl+Z" disabled={locked || !history.current.length || !!cropDraft} onClick={() => undo()}><Icon name="undo" /></button><button aria-label="重做" title="重做 Ctrl+Shift+Z" disabled={locked || !future.current.length || !!cropDraft} onClick={() => undo(true)}><Icon name="redo" /></button><button aria-label="导出" title="导出" disabled={busy || !onExport || !!cropDraft} aria-expanded={exportMenu} onClick={() => { setExportMenu(!exportMenu); setMenu(null); setTypeMenu(false); }}><Icon name="download" /></button></div>
    {!locked && !cropDraft && (tool === "shape" || tool === "stroke" || tool === "eraser") && <div className="oc-tool-options" data-owned-ui onPointerDown={stop}>{tool === "shape" ? <select aria-label="图形种类" value={shape} onChange={event => setShape(event.target.value as typeof shape)}><option value="rect">矩形</option><option value="ellipse">椭圆</option><option value="triangle">三角形</option><option value="star">星形</option><option value="line">直线</option><option value="arrow">箭头</option></select> : tool === "eraser" ? <><span>整条笔迹擦除</span><label>范围<input type="number" aria-label="橡皮擦范围" min="4" max="80" value={eraserSize} onChange={event => setEraserSize(clamp(Number(event.target.value) || 4, 4, 80))} /></label></> : null}{tool !== "eraser" && <><label>粗细<input type="number" aria-label="画笔粗细" min="1" max="80" value={lineWidth} onChange={event => setLineWidth(clamp(Number(event.target.value) || 1, 1, 80))} /></label><input type="color" aria-label="画笔颜色" value={color} onChange={event => setColor(event.target.value)} /></>}</div>}
    {exportMenu && <div className="oc-export-menu" data-owned-ui onPointerDown={stop} aria-label="画布导出菜单"><button aria-label="导出PNG" onClick={() => void exportDocument("png")}>整张画布 PNG</button><button aria-label="导出SVG" onClick={() => void exportDocument("svg")}>整张画布 SVG</button>{chosen.length > 0 && <><hr /><button aria-label="导出选中元素PNG" onClick={() => void exportDocument("png", { itemIds: expandSelection(view.items, selected) })}>选中元素 PNG</button><button aria-label="导出选中元素SVG" onClick={() => void exportDocument("svg", { itemIds: expandSelection(view.items, selected) })}>选中元素 SVG</button></>}{single?.kind === "frame" && <><hr /><button aria-label="导出当前画框PNG" onClick={() => void exportDocument("png", { frameId: single.id })}>当前画框 PNG</button><button aria-label="导出当前画框SVG" onClick={() => void exportDocument("svg", { frameId: single.id })}>当前画框 SVG</button></>}</div>}
    <div className="oc-zoom" data-owned-ui onPointerDown={stop}><button aria-label="缩小" onClick={() => { zoomAt(view.camera.zoom / 1.2); persistCamera(); }}><Icon name="minus" /></button><button aria-label="恢复100%缩放" onClick={() => { zoomAt(1); persistCamera(); }}>{Math.round(view.camera.zoom * 100)}%</button><button aria-label="放大" onClick={() => { zoomAt(view.camera.zoom * 1.2); persistCamera(); }}><Icon name="plus" /></button><button aria-label="适合画布" title="适合画布" onClick={fit}><Icon name="fit" /></button></div>
    <div className="oc-status" role="status" aria-live="polite" data-owned-ui onPointerDown={stop}>{status || (view.warnings.length ? "此项目包含尚未支持的内容，已保留原稿并以只读方式打开。" : "")}</div>
    <input ref={uploader} type="file" accept="image/*" multiple hidden onChange={event => { void upload(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
    <input ref={replacement} data-testid="owned-replace-image-input" aria-label="替换图片文件" type="file" accept="image/*" hidden onChange={event => { const id = replacingId.current, files = Array.from(event.target.files ?? []); event.target.value = ""; replacingId.current = null; if (id) void replaceImage(id, files); }} />
  </div>;
}

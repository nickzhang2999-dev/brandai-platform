"use client";

/**
 * §L8 · 参考素材暂存盘（client-side staging）— assets → workspace/Campaign 的轻量联动。
 *
 * 一期还没有 Project↔Asset 的 DB 关系（phase-2 backlog），所以"设为参考 / 加入项目"
 * 先用 localStorage 在浏览器侧暂存：按 (wsId, projectId) 维度存一组 RefAsset，工作台
 * 出图时读这盘把它们带进 references。等服务端落了真关系再替换底座，公共 API 不变。
 *
 * SSR-safe：所有 window/localStorage 访问都 guard `typeof window`，在服务端渲染时退化为
 * 空数组 / no-op。
 */

export type RefAsset = { id: string; fileName?: string; thumbUrl?: string };

const PREFIX = "brandai:reftray:";
/** 每个项目最多暂存这么多参考素材；满了拒绝新增（no-op）。 */
const CAP = 8;
/** 同标签页内变更通知事件名（storage 事件不会在写入它的 tab 触发）。 */
const EVENT = "brandai:reftray-change";

function keyFor(wsId: string, projectId: string): string {
  return `${PREFIX}${wsId}:${projectId}`;
}

function read(key: string): RefAsset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is RefAsset =>
        !!x && typeof x === "object" && typeof (x as RefAsset).id === "string",
    );
  } catch {
    return [];
  }
}

function write(key: string, list: RefAsset[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* quota / private mode — ignore */
  }
  // 通知同一标签页内的订阅者（storage 事件只在其他 tab 触发）。
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* ignore */
  }
}

export function getReferences(wsId: string, projectId: string): RefAsset[] {
  return read(keyFor(wsId, projectId));
}

/** 追加一个参考素材；按 id 去重；满 CAP 则拒绝（no-op）。 */
export function addReference(
  wsId: string,
  projectId: string,
  asset: RefAsset,
): void {
  const key = keyFor(wsId, projectId);
  const list = read(key);
  if (list.some((a) => a.id === asset.id)) return; // 去重
  if (list.length >= CAP) return; // 满则拒绝
  write(key, [...list, asset]);
}

export function removeReference(
  wsId: string,
  projectId: string,
  assetId: string,
): void {
  const key = keyFor(wsId, projectId);
  const list = read(key);
  const next = list.filter((a) => a.id !== assetId);
  if (next.length !== list.length) write(key, next);
}

export function clearReferences(wsId: string, projectId: string): void {
  const key = keyFor(wsId, projectId);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* ignore */
  }
}

/**
 * 订阅任意 reftray 变更（跨 tab 的 `storage` + 本 tab 的自定义事件）。
 * 返回取消订阅函数，移除两个监听器。
 */
export function subscribeReferences(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(PREFIX)) cb();
  };
  const onLocal = () => cb();
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT, onLocal);
  };
}

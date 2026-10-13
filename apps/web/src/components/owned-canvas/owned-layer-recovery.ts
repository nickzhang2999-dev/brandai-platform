import { StudioDecompositionInput, type StudioDecompositionInput as Input } from "../../../../../packages/contracts/src/studio-decomposition";

type Identity = { workspaceId: string; projectId: string; userId: string };
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const blocked = () => new Error("分层确认记录暂不可读，请先查看服务器任务，暂不提交新的分层。");

/** Input journal only. A reload reads server tasks and never calls a provider. */
export function createOwnedLayerRecovery(identity: Identity, supplied?: StoragePort) {
  if (Object.values(identity).some(value => !/^[A-Za-z0-9_-]{1,128}$/.test(value))) throw blocked();
  const key = "novart-owned-layer-pending-v1:" + [identity.workspaceId, identity.userId, identity.projectId].map(encodeURIComponent).join(":");
  const port = () => { try { return supplied ?? window.sessionStorage; } catch { throw blocked(); } };
  const parse = (raw: unknown) => {
    const result = StudioDecompositionInput.safeParse(raw);
    if (!result.success || result.data.projectId !== identity.projectId) throw blocked();
    return result.data;
  };
  const signature = (raw: Input) => JSON.stringify(parse(raw));
  function load(): Input | null {
    try {
      const raw = port().getItem(key);
      if (raw === null) return null;
      if (!raw.length || raw.length > 8192) throw blocked();
      const record = JSON.parse(raw);
      if (record.version !== 1 || Object.keys(record).length !== 5 || record.workspaceId !== identity.workspaceId
        || record.userId !== identity.userId || record.projectId !== identity.projectId) throw blocked();
      return parse(record.input);
    } catch { throw blocked(); }
  }
  return {
    load,
    store(raw: Input) {
      const next = parse(raw), previous = load();
      if (previous && signature(previous) !== signature(next)) throw blocked();
      try { port().setItem(key, JSON.stringify({ version: 1, ...identity, input: next })); } catch { throw blocked(); }
      const restored = load();
      if (!restored || signature(restored) !== signature(next)) throw blocked();
      return restored;
    },
    clear(expected: Input) {
      const current = load(); if (!current) return;
      if (signature(current) !== signature(expected)) throw blocked();
      try { port().removeItem(key); if (port().getItem(key) !== null) throw blocked(); } catch { throw blocked(); }
    },
  };
}

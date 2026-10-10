import { z } from "zod";
import { StudioGenerationInput } from "@brandai/contracts";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const Identity = z.object({ workspaceId: id, projectId: id, userId: id }).strict();
const Intent = z.object({ mode: z.enum(["generate", "modify"]), input: StudioGenerationInput }).strict();
const Record = Identity.extend({ version: z.literal(1), intent: Intent }).strict();
const MAX_RECORD_CHARS = 32 * 1024;
export type OwnedGenerationIntent = z.infer<typeof Intent>;
export type OwnedGenerationIdentity = z.infer<typeof Identity>;
export type OwnedGenerationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** No user input, storage contents or exception detail goes into this error. */
export class OwnedGenerationRecoveryError extends Error {
  readonly code = "GENERATION_RECOVERY_BLOCKED";
  constructor(message = "上一份创作的确认记录暂不可读。请保留此页面，先查看服务器任务；暂不允许提交新创作。") {
    super(message); this.name = "OwnedGenerationRecoveryError";
  }
}

/** This is a bounded input journal, never a task status or a second server.
 * A successful write/readback must precede the first paid POST. Loading never
 * submits, expires or deletes an intent. Only a checked server acknowledgement
 * (or a definitive rejection) authorizes the caller to clear that exact intent.
 * sessionStorage deliberately covers same-tab reloads; it is not advertised as
 * cross-device or browser-session task recovery. Server receipts own that state. */
export function createOwnedGenerationRecovery(rawIdentity: OwnedGenerationIdentity, suppliedStorage?: OwnedGenerationStorage) {
  const parsedIdentity = Identity.safeParse(rawIdentity);
  if (!parsedIdentity.success) throw new OwnedGenerationRecoveryError("无法确认当前项目身份，已停止提交创作。");
  const identity = parsedIdentity.data;
  const key = "novart-owned-generation-pending-v1:" + [identity.workspaceId, identity.userId, identity.projectId].map(encodeURIComponent).join(":");
  function storage() {
    try {
      const value = suppliedStorage ?? window.sessionStorage;
      if (!value) throw new Error();
      return value;
    } catch { throw new OwnedGenerationRecoveryError("浏览器暂不能保存创作确认记录。请恢复存储空间或访问权限后重试；本次不会提交生成。"); }
  }
  function intent(raw: unknown): OwnedGenerationIntent {
    const value = Intent.safeParse(raw);
    if (!value.success || value.data.input.projectId !== identity.projectId || value.data.mode === "modify" && value.data.input.outputFrameId !== undefined) {
      throw new OwnedGenerationRecoveryError("创作确认记录与当前项目或操作不一致，原记录已保留，请先检查已有任务。");
    }
    return value.data;
  }
  const signature = (value: OwnedGenerationIntent) => JSON.stringify(intent(value));
  function load(): OwnedGenerationIntent | null {
    let raw: string | null;
    try { raw = storage().getItem(key); }
    catch (error) { if (error instanceof OwnedGenerationRecoveryError) throw error; throw new OwnedGenerationRecoveryError(); }
    if (raw === null) return null;
    if (typeof raw !== "string" || !raw.length || raw.length > MAX_RECORD_CHARS) throw new OwnedGenerationRecoveryError();
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { throw new OwnedGenerationRecoveryError(); }
    const parsed = Record.safeParse(decoded);
    if (!parsed.success || parsed.data.workspaceId !== identity.workspaceId || parsed.data.userId !== identity.userId || parsed.data.projectId !== identity.projectId) throw new OwnedGenerationRecoveryError();
    return intent(parsed.data.intent);
  }
  return {
    load,
    store(raw: OwnedGenerationIntent): OwnedGenerationIntent {
      const next = intent(raw), before = load();
      if (before && signature(before) !== signature(next)) throw new OwnedGenerationRecoveryError("上一份创作的受理结果还未确认，请先确认同一份请求，暂不创建新任务。");
      const serialized = JSON.stringify({ ...identity, version: 1, intent: next });
      if (serialized.length > MAX_RECORD_CHARS) throw new OwnedGenerationRecoveryError("创作确认记录过大，尚未提交生成，请缩短需求后重试。");
      try { storage().setItem(key, serialized); }
      catch { throw new OwnedGenerationRecoveryError("创作确认记录未能保存，尚未提交生成。请恢复浏览器存储后继续。"); }
      const stored = load();
      if (!stored || signature(stored) !== signature(next)) throw new OwnedGenerationRecoveryError("创作确认记录写入后未能核对，尚未提交生成。请保留本页并检查存储。");
      return stored;
    },
    clear(expected: OwnedGenerationIntent): void {
      const confirmed = intent(expected), stored = load();
      if (!stored) return;
      if (signature(stored) !== signature(confirmed)) throw new OwnedGenerationRecoveryError("待确认请求已经变化，未删除其恢复记录，请重新查看任务。");
      try {
        storage().removeItem(key);
        if (storage().getItem(key) !== null) throw new Error();
      } catch { throw new OwnedGenerationRecoveryError("任务结果已返回，但确认记录暂未清理成功。请继续核对同一任务，暂不提交新创作。"); }
    },
  };
}

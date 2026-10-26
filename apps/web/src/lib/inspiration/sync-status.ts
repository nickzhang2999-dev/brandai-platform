import type { InspirationSyncChannel, InspirationSyncStatus } from '@brandai/contracts';

export const CONTENT_SYNC_ERROR = '内容同步失败，请管理员检查发布连接或校验结果。';
export const WITHDRAWAL_SYNC_ERROR = '撤回检查失败，最新撤回状态尚未确认，请管理员检查发布连接。';
export const LEGACY_SYNC_ERROR = '历史同步检查曾失败，等待新一轮检查确认。';
export const CONTENT_STALE_MS = 10 * 60_000;
export const WITHDRAWAL_STALE_MS = 3 * 60_000;

type State = {
  lastSyncAt?: Date | null; lastError?: string | null;
  lastSyncAttemptAt?: Date | null; lastSyncFailedAt?: Date | null; syncError?: string | null;
  lastWithdrawalAttemptAt?: Date | null; lastWithdrawalAt?: Date | null; lastWithdrawalFailedAt?: Date | null;
  withdrawalError?: string | null; withdrawalHash?: string | null;
};
const iso = (value?: Date | null) => value?.toISOString() ?? null;
const hash = (value?: string | null) => value && /^[a-f0-9]{64}$/.test(value) ? value : null;

export function inspirationSyncStatus(state: State | null, manifestHash: string | null, enabled: boolean, configured: boolean, now = Date.now()): InspirationSyncStatus {
  function channel(attempt: Date | null | undefined, success: Date | null | undefined, failure: Date | null | undefined, error: string | null, maxAge: number): InspirationSyncChannel {
    const status = !enabled ? 'disabled' : !configured ? 'unconfigured' : error ? 'error' : !success ? 'unknown'
      : now - success.getTime() > maxAge || success.getTime() > now + 60_000 ? 'stale' : 'healthy';
    return {state: status, lastAttemptAt: iso(attempt), lastSuccessAt: iso(success), lastFailureAt: iso(failure), error};
  }
  const contentError = state?.syncError ? CONTENT_SYNC_ERROR : state?.lastError ? LEGACY_SYNC_ERROR : null;
  return {
    content: channel(state?.lastSyncAttemptAt, state?.lastSyncAt, state?.lastSyncFailedAt, contentError, CONTENT_STALE_MS),
    withdrawals: channel(state?.lastWithdrawalAttemptAt, state?.lastWithdrawalAt, state?.lastWithdrawalFailedAt, state?.withdrawalError ? WITHDRAWAL_SYNC_ERROR : null, WITHDRAWAL_STALE_MS),
    activeManifestHash: hash(manifestHash), withdrawalHash: hash(state?.withdrawalHash),
  };
}

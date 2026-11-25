import { NovartApiError } from "../../lib/novart-api-client";

export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!/[a-z]/i.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function generationReadFailure(error: unknown, failures: number, remaining: number, random = Math.random) {
  if (!(error instanceof NovartApiError)) return { stop: true, permanent: true, delay: 0, message: "任务状态暂不可读，请手动刷新任务。" };
  const status = error.status;
  if (status === 401 || status === 403) return { stop: true, permanent: true, delay: 0, message: "登录已失效或没有项目权限，请确认账号后刷新任务。" };
  if (status !== null && status !== 408 && status !== 429 && !(status >= 500 && status < 600))
    return { stop: true, permanent: true, delay: 0, message: error.message };
  const backoff = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
  const delay = Math.max(Math.round(backoff * (0.75 + random() * 0.5)), status === 429 ? error.retryAfterMs ?? 0 : 0);
  return { permanent: false, stop: failures >= 5 || delay >= remaining, delay, message: "自动查询已暂停，可稍后刷新任务查看原结果。" };
}

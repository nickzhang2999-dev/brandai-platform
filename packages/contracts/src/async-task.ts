import { z } from "zod";
import { JobStatus } from "./enums";

/**
 * H-async — server-authoritative async task state (web-BFF-only). Lets
 * recognize / parse-manual / edit be refresh-resumable (`?task=`) with a real
 * progress %, mirroring the generate `?gen=` pattern.
 */
export const AsyncTaskKind = z.enum([
  "RECOGNIZE",
  "PARSE_MANUAL",
  "EDIT",
  // E9/E10 — asset auto-tagging (POST /assets/[id]/describe → describe worker).
  "DESCRIBE",
  // K3 / §2 — website ingest crawl (POST /ingest → ingest worker). The AI
  // crawl is slow, so it runs server-authoritatively in a worker instead of
  // being awaited in the HTTP handler. The candidate result is read back via
  // the job return value (GET ?jobId=).
  "INGEST",
  // B2/C8 — text summarization (brief decompose / campaign summary). The VLM
  // chat call is slow, so it runs server-authoritatively in the summarize
  // worker (POST → 202 → client polls). The structured result is read back via
  // the job return value (GET ?jobId=).
  "SUMMARIZE",
  // 图层分解（AI 分层）。实测真上游一次调用 12–42 秒，第一次就打穿 30 秒边缘
  // 网关上限 —— 同步这条路拿不到结果，必须走 worker。refId = 图层组 id，
  // refCount = 实际落库的图层数。
  "DECOMPOSE",
]);
export type AsyncTaskKind = z.infer<typeof AsyncTaskKind>;

export const TaskState = z.object({
  id: z.string(),
  workspaceId: z.string(),
  kind: AsyncTaskKind,
  status: JobStatus,
  progress: z.number().int(),
  jobId: z.string().optional(),
  /** produced resource id (e.g. an edited version) when applicable */
  refId: z.string().optional(),
  /** count of produced resources (e.g. recognized rules) */
  refCount: z.number().int(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskState = z.infer<typeof TaskState>;

/* ------------------------------------------------------------------ *
 * 客户端中间态上界（§2.4）的起算点
 * ------------------------------------------------------------------ */

/**
 * 这一刻算不算「等太久了」。
 *
 * 判据的要害是**起算点**,不是那个 6 分钟。worker 侧的看门狗是从任务**开跑**才
 * 计时的,客户端若从**提交**计时,两边就不是同一个口径:worker 并发为 1,前面压着
 * 一条真上游分解(实测 12–110 秒,慢的更久)时,后一条能在 PENDING 里躺很久。
 * 客户端会在这条任务还没轮到它跑的时候判它超时——而它其实一切正常。
 *
 * 所以排队不吃工作预算:见到 RUNNING 就重新起算,两边同口径。
 *
 * 排队本身仍然有界(仍从 `submittedAt` 起算),否则 Redis 挂了、worker 没起来时
 * 会无限转圈。区别只在于:排队超时不代表这次分解失败,调用方该保住任务线索让它
 * 可续,而不是把 taskId 抹掉逼用户重新花一次钱。
 */
export function isTaskWatchExpired(input: {
  /** 提交时刻。 */
  submittedAt: number;
  /** 首次观察到 RUNNING 的时刻；还在排队时为 0。 */
  runningAt: number;
  now: number;
  capMs: number;
}): boolean {
  const from = input.runningAt > 0 ? input.runningAt : input.submittedAt;
  if (from <= 0) return false;
  return input.now - from > input.capMs;
}

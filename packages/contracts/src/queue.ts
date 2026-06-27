import { z } from "zod";
import { SceneType, JobStatus } from "./enums";

/**
 * §2.3 observable surface — wire format for the bottom-right queue widget
 * and the admin activity log.
 *
 * The queue widget shows live, workspace-scoped jobs (server-authoritative
 * status + ticking elapsed). It only needs the columns to render a row, so
 * we don't ship full `Generation` here — keeps the polling payload small.
 *
 * `progress` is intentionally COARSE (status-derived 0/50/100). Reading the
 * exact BullMQ % would require an extra `getJob` per row per poll. The
 * wizard's existing single-job poll (`?jobId=`) keeps the precise live %.
 */
export const QueueItem = z.object({
  id: z.string(),
  /** Owning Campaign (project) id — lets the queue widget deep-link the row to
   *  `/workspace?gen=<id>&project=<projectId>` so a finished row is one click
   *  from the image (E · 看得到完成→点得进图). Optional for forward-compat. */
  projectId: z.string().optional(),
  status: JobStatus,
  /** Coarse status-derived progress (0=PENDING, 50=RUNNING, 100=SUCCEEDED,
   *  last-known/0=FAILED). See file-level comment. */
  progress: z.number().int(),
  sceneType: SceneType,
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number().int().optional(),
  versionCount: z.number().int(),
  error: z.string().nullable().optional(),
});
export type QueueItem = z.infer<typeof QueueItem>;

export const QueueResponse = z.object({
  items: z.array(QueueItem),
  /** Number of PENDING+RUNNING items in `items`. The widget uses this to
   *  switch between fast-poll (anything active) and idle (back off / hide). */
  activeCount: z.number().int(),
});
export type QueueResponse = z.infer<typeof QueueResponse>;

/**
 * §2.3 observable history — OpenRouter-style per-request log. Source is
 * `UsageLog` rows (admin-global; see `/api/admin/activity`). Emphasizes
 * TIMING (`latencyMs`) and "did it return content?" (`imageCount > 0`).
 */
export const ActivityRow = z.object({
  id: z.string(),
  createdAt: z.string(),
  kind: z.string(),
  status: z.enum(["SUCCEEDED", "FAILED"]),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  size: z.string().nullable().optional(),
  imageCount: z.number().int(),
  costUsd: z.number().nullable().optional(),
  latencyMs: z.number().int().nullable().optional(),
  workspaceId: z.string().optional(),
  /** Provider-reported total tokens (null when unreported). */
  totalTokens: z.number().int().nullable().optional(),
  /** A representative thumbnail for this row, resolved on read from the soft
   *  generationId reference (null when no image / generation deleted). */
  imageUrl: z.string().nullable().optional(),
});
export type ActivityRow = z.infer<typeof ActivityRow>;

export const ActivityResponse = z.object({
  rows: z.array(ActivityRow),
  /** ISO timestamp of the row to start the next page before, or null when
   *  there are no more rows. Cursor-based so new rows arriving don't shift
   *  pagination. */
  nextCursor: z.string().nullable(),
});
export type ActivityResponse = z.infer<typeof ActivityResponse>;

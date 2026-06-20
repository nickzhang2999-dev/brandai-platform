import { z } from "zod";

/**
 * A3 / L3 — in-app notification center (web-BFF-only; never crosses to the AI
 * service). Notifications are NOT a separate persisted table — they are derived
 * on read from real server state: terminal `AsyncTask` rows (recognize /
 * parse-manual / edit / describe / ingest) and terminal `Generation` rows
 * (generate, SUCCEEDED / FAILED). The read endpoint
 * `GET /api/workspaces/[wsId]/notifications` shapes those rows into this wire
 * format; unread state is tracked client-side via a localStorage `lastSeenAt`
 * marker compared against each row's `createdAt` (no migration required).
 *
 * Keep this in lock-step with `lib/notifications.ts` (the only producer).
 */

/** The kind of source event a notification was derived from. */
export const NotificationKind = z.enum([
  "GENERATE",
  "EDIT",
  "RECOGNIZE",
  "PARSE_MANUAL",
  "DESCRIBE",
  "INGEST",
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** Terminal status only — the inbox lists completed work, not in-flight. */
export const NotificationStatus = z.enum(["SUCCEEDED", "FAILED"]);
export type NotificationStatus = z.infer<typeof NotificationStatus>;

export const NotificationItem = z.object({
  /** Stable id (the source row id, prefixed by kind so generate/task ids can't
   *  collide). */
  id: z.string(),
  kind: NotificationKind,
  status: NotificationStatus,
  /** Human-readable one-line title (e.g. "出图完成 · 社交海报"). */
  title: z.string(),
  /** Readable failure reason (FAILED) or a short success detail; optional. */
  detail: z.string().nullable().optional(),
  /** Same-app link back to the source (e.g. "/workspace", "/brand-knowledge"). */
  href: z.string().nullable().optional(),
  /** ISO timestamp the event reached its terminal state (used for unread
   *  comparison + ordering). */
  createdAt: z.string(),
});
export type NotificationItem = z.infer<typeof NotificationItem>;

export const NotificationsResponse = z.object({
  items: z.array(NotificationItem),
});
export type NotificationsResponse = z.infer<typeof NotificationsResponse>;

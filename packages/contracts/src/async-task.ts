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

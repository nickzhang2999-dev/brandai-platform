import { z } from "zod";
import { JobStatus } from "./enums";

/**
 * H-async — server-authoritative async task state (web-BFF-only). Lets
 * recognize / parse-manual / edit be refresh-resumable (`?task=`) with a real
 * progress %, mirroring the generate `?gen=` pattern.
 */
export const AsyncTaskKind = z.enum(["RECOGNIZE", "PARSE_MANUAL", "EDIT"]);
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

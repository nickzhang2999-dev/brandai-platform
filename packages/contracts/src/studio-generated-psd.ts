import { z } from "zod";
import { StudioGenerationRetryInput } from "./studio-generation";
import { StudioDecompositionView } from "./studio-decomposition";

export const StudioGeneratedPsdQuery = StudioGenerationRetryInput;
export const StudioGeneratedPsdView = z.object({
  projectId: StudioGeneratedPsdQuery.shape.projectId,
  requestId: StudioGeneratedPsdQuery.shape.requestId,
  requested: z.boolean(),
  status: z.enum(["NOT_REQUESTED", "PENDING", "RUNNING", "READY", "FAILED"]),
  error: z.string().max(1000).nullable(),
  decomposition: StudioDecompositionView.nullable(),
  downloadUrl: z.string().regex(/^\/api\/workspaces\/[A-Za-z0-9_-]{1,128}\/studio\/decomposition\/[A-Za-z0-9_-]{1,128}\/export\?projectId=[A-Za-z0-9_-]{1,128}&format=psd$/).nullable(),
}).strict().superRefine((view, context) => {
  if (view.requested !== (view.status !== "NOT_REQUESTED")) context.addIssue({ code: "custom", message: "PSD intent and state must agree" });
  if (view.status === "READY" && (!view.downloadUrl || view.decomposition?.status !== "SUCCEEDED" || view.decomposition.projectId !== view.projectId)) context.addIssue({ code: "custom", message: "PSD needs complete persisted scoped layers" });
  if (view.status !== "READY" && view.downloadUrl) context.addIssue({ code: "custom", message: "An unfinished PSD cannot be downloaded" });
  if (view.status === "NOT_REQUESTED" && (view.error || view.decomposition)) context.addIssue({ code: "custom", message: "Unrequested PSD has no job or failure" });
});
export type StudioGeneratedPsdQuery = z.infer<typeof StudioGeneratedPsdQuery>;
export type StudioGeneratedPsdView = z.infer<typeof StudioGeneratedPsdView>;

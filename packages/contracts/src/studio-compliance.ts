import { z } from "zod";
import { NativeProjectQueryInput } from "./native-project";
import { ComplianceReport } from "./entities";

const Id = NativeProjectQueryInput.shape.projectId;
export const StudioGenerationComplianceInput = z.object({ projectId: Id, versionId: Id }).strict();
export const StudioGenerationComplianceQuery = StudioGenerationComplianceInput;
export const StudioGenerationComplianceView = z.object({
  taskId: Id.nullable(), versionId: Id,
  status: z.enum(["NOT_REQUESTED", "PENDING", "RUNNING", "SUCCEEDED", "FAILED"]),
  progress: z.number().int().min(0).max(100), expiresAt: z.string().datetime().nullable(),
  checkedImageSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  report: ComplianceReport.nullable(), error: z.string().nullable(), canRetry: z.boolean(),
}).strict().superRefine((value, context) => {
  if ((value.status === "SUCCEEDED") !== (value.report !== null && value.checkedImageSha256 !== null)) {
    context.addIssue({ code: "custom", message: "Only a completed real check has a report and checked image digest" });
  }
  if (value.status !== "SUCCEEDED" && (value.report !== null || value.checkedImageSha256 !== null)) {
    context.addIssue({ code: "custom", message: "Incomplete checks must not expose a previous report" });
  }
  if (value.status === "FAILED" && !value.error) context.addIssue({ code: "custom", message: "Failed checks need a readable reason" });
  if (value.status === "NOT_REQUESTED" ? value.taskId !== null || value.expiresAt !== null : value.taskId === null || value.expiresAt === null) {
    context.addIssue({ code: "custom", message: "Task identity and deadline must match the check state" });
  }
});
export type StudioGenerationComplianceInput = z.infer<typeof StudioGenerationComplianceInput>;
export type StudioGenerationComplianceView = z.infer<typeof StudioGenerationComplianceView>;

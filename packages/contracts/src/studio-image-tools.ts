import { z } from "zod";
import { NativeProjectQueryInput } from "./native-project";
import { StudioWorkflowTarget } from "./studio-workflow";

export const STUDIO_IMAGE_TOOLS_REVISION = "studio-image-tools-r1";
export const STUDIO_IMAGE_TOOL_MASK_MAX_BYTES = 1024 * 1024;
export const STUDIO_IMAGE_TOOL_MAX_PIXELS = 16_777_216;
const maxDataLength = Math.ceil(STUDIO_IMAGE_TOOL_MASK_MAX_BYTES / 3) * 4 + 64;
const mask = z.string().max(maxDataLength).refine(value => {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  const payload = match?.[1];
  if (!payload || payload.length % 4 || (payload.endsWith("==") ? !/[AQgw]==$/.test(payload) : payload.endsWith("=") && !/[AEIMQUYcgkosw048]=$/.test(payload))) return false;
  const size = payload.length / 4 * 3 - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
  return size > 0 && size <= STUDIO_IMAGE_TOOL_MASK_MAX_BYTES;
}, "A bounded canonical PNG mask is required");
export const StudioImageToolSpec = z.object({
  operation: z.enum(["remove-background", "inpaint"]), mask: mask.optional(),
}).strict().superRefine((value, context) => {
  if ((value.operation === "inpaint") !== (value.mask !== undefined)) context.addIssue({ code: "custom", path: ["mask"], message: "Only inpainting requires a mask" });
});
export const StudioImageToolInput = NativeProjectQueryInput.pick({ projectId: true }).extend({
  mutationId: z.string().uuid(), documentRevision: z.number().int().min(0).max(2147483646),
  workflowRevision: z.number().int().min(0).max(2147483646), target: StudioWorkflowTarget,
  operation: z.enum(["remove-background", "inpaint"]), mask: mask.optional(),
  instruction: z.string().trim().min(1).max(4000).optional(),
}).strict().superRefine((value, context) => {
  if ((value.operation === "inpaint") !== (value.mask !== undefined)) context.addIssue({ code: "custom", path: ["mask"], message: "Only inpainting requires a mask" });
});
const capability = z.object({ available: z.boolean(), reason: z.string().nullable() }).strict();
export const StudioImageToolCapabilities = z.object({ revision: z.literal(STUDIO_IMAGE_TOOLS_REVISION),
  removeBackground: capability, inpaint: capability,
  maskConvention: z.literal("white-edit-black-preserve"), maxMaskBytes: z.literal(STUDIO_IMAGE_TOOL_MASK_MAX_BYTES),
  maxPixels: z.literal(STUDIO_IMAGE_TOOL_MAX_PIXELS),
}).strict();
export type StudioImageToolSpec = z.infer<typeof StudioImageToolSpec>;
export type StudioImageToolInput = z.infer<typeof StudioImageToolInput>;

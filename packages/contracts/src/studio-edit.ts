import { z } from "zod";
import { GenerateRequest, GenerateResponse, SizeSpec } from "./ai";

export const STUDIO_EDIT_REVISION = "studio-whole-image-edit-r1";
export const STUDIO_EDIT_MAX_BYTES = 32 * 1024 * 1024;
export const STUDIO_EDIT_MAX_IMAGES = 16;
const maxDataLength = Math.ceil(STUDIO_EDIT_MAX_BYTES / 3) * 4 + 64;
// Canonical base64, including zero padding bits; no URLs can trigger a fetch.
const dataPattern = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
function dataBytes(value: string): number | null {
  if (value.length > maxDataLength) return null;
  const match = dataPattern.exec(value);
  if (!match?.[2]) return null;
  const payload = match[2];
  if (payload.length % 4 || (payload.endsWith("==") ? !/[AQgw]==$/.test(payload) : payload.endsWith("=") && !/[AEIMQUYcgkosw048]=$/.test(payload))) return null;
  const length = payload.length / 4 * 3 - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);
  return length > 0 && length <= STUDIO_EDIT_MAX_BYTES ? length : null;
}
const source = z.string().max(maxDataLength).refine(value => dataBytes(value) !== null, "A bounded static PNG/JPEG/WebP data URI is required");
const generation = GenerateRequest.extend({
  providerRetryPolicy: z.literal("never"),
  versionCount: z.literal(1),
  targets: z.array(SizeSpec.strict()).length(1),
}).strict();

/** Internal-only request; web resolves source ownership/SHA before transport. */
export const StudioEditRequest = z.object({ imageUrl: source, generation }).strict().superRefine((input, ctx) => {
  const refs = input.generation.aiConstraints?.referenceImages ?? [];
  if (refs.length + 1 > STUDIO_EDIT_MAX_IMAGES) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["generation", "aiConstraints", "referenceImages"], message: "Source plus references exceed the image limit" });
  let total = dataBytes(input.imageUrl) ?? 0;
  refs.forEach((ref, index) => {
    const size = dataBytes(ref.url);
    if (size === null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["generation", "aiConstraints", "referenceImages", index, "url"], message: "Every reference must be a bounded static image data URI" });
    else total += size;
  });
  if (total > STUDIO_EDIT_MAX_BYTES) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Combined source and references exceed 32 MiB" });
});
export type StudioEditRequest = z.infer<typeof StudioEditRequest>;
export const StudioEditResponse = GenerateResponse.extend({ versions: GenerateResponse.shape.versions.length(1) });
export type StudioEditResponse = z.infer<typeof StudioEditResponse>;

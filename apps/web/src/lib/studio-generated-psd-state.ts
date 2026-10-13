import { createHash } from "node:crypto";
import { z } from "zod";

/** Selected at generation intake. No browser preference can change a receipt. */
export function generatedPsdLayerCount(jobData: unknown): number | null {
  const value = jobData && typeof jobData === "object" && !Array.isArray(jobData)
    ? (jobData as Record<string, unknown>).studioPsdLayerCount : undefined;
  const parsed = z.number().int().min(2).max(10).safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function generatedPsdLayerMode(jobData: unknown): "AUTO" | "MANUAL" | null {
  if (!jobData || typeof jobData !== "object" || Array.isArray(jobData)) return null;
  const job = jobData as Record<string, unknown>;
  if (job.studioPsdLayerMode === "AUTO") return "AUTO";
  return generatedPsdLayerCount(jobData) === null ? null : "MANUAL";
}
export const GeneratedPsdOutbox = z.object({
  status: z.enum(["PENDING", "REGISTERED", "FAILED"]),
  decompositionRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullable(),
  error: z.string().max(1000).nullable(),
}).strict();
export function generatedPsdOutbox(jobData: unknown) {
  const value = jobData && typeof jobData === "object" && !Array.isArray(jobData)
    ? (jobData as Record<string, unknown>).studioGeneratedPsd : undefined;
  return GeneratedPsdOutbox.safeParse(value);
}
export function generatedPsdIntent(layerCount: number | undefined, mode?: "AUTO" | "MANUAL") {
  if (mode === "AUTO") {
    if (layerCount !== undefined) throw new Error("AUTO PSD count is server-selected");
    return { studioPsdLayerMode: "AUTO" as const,
      studioGeneratedPsd: { status: "PENDING" as const, decompositionRequestId: null, error: null } };
  }
  if (layerCount === undefined) return {};
  z.number().int().min(2).max(10).parse(layerCount);
  return { studioPsdLayerCount: layerCount,
    studioGeneratedPsd: { status: "PENDING" as const, decompositionRequestId: null, error: null } };
}
/** A retry or crash always maps to the same paid request, never a fresh UUID. */
export function generatedPsdMutationId(requestId: string, mutationId: string) {
  const digest = createHash("sha256").update(`novart-generated-psd-v1:${requestId}:${mutationId}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
export function generatedPsdSourceShapeId(assetId: string) {
  return `shape:generated-${createHash("sha256").update(assetId).digest("hex").slice(0, 40)}`;
}

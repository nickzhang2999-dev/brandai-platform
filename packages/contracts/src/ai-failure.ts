import { z } from "zod";

/** Internal AI -> worker failure envelope. Never include provider text or URLs. */
export const AiFailureCode = z.enum([
  "SOURCE_UNAVAILABLE", "PROVIDER_RATE_LIMITED", "PROVIDER_AUTH",
  "PROVIDER_REQUEST_REJECTED", "PROVIDER_UNAVAILABLE", "PROVIDER_TIMEOUT",
  "PROVIDER_NETWORK", "PROVIDER_INVALID_RESPONSE", "AI_REQUEST_FAILED",
]);
export const AiFailureResponse = z.object({
  schemaVersion: z.literal(1),
  error: z.object({
    code: AiFailureCode,
    stage: z.enum(["source", "provider", "response", "unknown"]),
    upstreamStatus: z.number().int().min(400).max(599).nullable(),
  }).strict(),
}).strict();
export type AiFailureInfo = z.infer<typeof AiFailureResponse>["error"];

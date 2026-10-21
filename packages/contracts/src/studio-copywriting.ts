import { z } from "zod";

export const StudioCopywritingInput = z.object({
  mutationId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(2000),
  mode: z.enum(["GENERATE", "REWRITE"]).default("GENERATE"),
  sourceText: z.string().trim().max(4000).default(""),
  tone: z.enum(["自然", "简洁", "活泼", "专业"]).default("自然"),
  image: z.object({ assetId: z.string().min(1).max(128), assetSha256: z.string().regex(/^[a-f0-9]{64}$/i) }).strict().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.mode === "REWRITE" && !v.sourceText) ctx.addIssue({ code: "custom", path: ["sourceText"], message: "请先选中画布文字，或输入需要改写的原文。" });
});
export type StudioCopywritingInput = z.infer<typeof StudioCopywritingInput>;
export const StudioCopywritingCandidate = z.object({
  title: z.string().trim().min(1).max(100),
  body: z.string().trim().min(1).max(1000),
}).strict();
export const StudioCopywritingResult = z.object({
  candidates: z.array(StudioCopywritingCandidate).min(1).max(3),
  model: z.string(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
});
export type StudioCopywritingResult = z.infer<typeof StudioCopywritingResult>;
export const StudioCopywritingTask = z.object({
  id: z.string(), mutationId: z.string().uuid(), prompt: z.string(),
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]),
  createdAt: z.string(), error: z.string().nullable(), result: StudioCopywritingResult.nullable(),
});
export type StudioCopywritingTask = z.infer<typeof StudioCopywritingTask>;
export const StudioCopywritingList = z.object({ enabled: z.boolean(), tasks: z.array(StudioCopywritingTask) });

import { z } from "zod";
import { StudioWorkflowTarget } from "./studio-workflow";
import { NativeProjectQueryInput } from "./native-project";

export const SolPosterChoices = z.object({
  appearance: z.enum(["正面主视", "轮廓留白"]), scene: z.enum(["日常使用环境", "陈列台", "纯色摄影背景"]),
  detail: z.enum(["局部放大", "引线标注"]),
}).strict();
const SolSessionTurn = z.object({
  message: z.string().trim().min(1).max(600),
  parentId: z.string().regex(/^spb_[0-9a-f]{64}$/).optional(),
  direction: SolPosterChoices.optional(),
  audience: z.string().trim().min(1).max(160).optional(),
}).strict();

export const SolPosterInput = z.object({
  mutationId: z.string().uuid(), target: StudioWorkflowTarget,
  documentRevision: z.number().int().nonnegative(), contextRevision: z.number().int().nonnegative(),
  conversation: SolSessionTurn.optional(),
  styleAssetId: NativeProjectQueryInput.shape.projectId.optional(),
}).strict();
export type SolPosterInput = z.infer<typeof SolPosterInput>;

export const SolPosterConfirm = SolPosterInput.pick({ target: true, documentRevision: true, contextRevision: true }).extend({
  action: z.literal("confirm-appearance"), briefId: z.string().regex(/^spb_[0-9a-f]{64}$/),
}).strict();

export const SolPosterModelInput = z.object({
  product: z.string().min(1).max(512), brand: z.string().max(512),
  goal: z.string().max(1000), audience: z.string().max(1000), visualRequirements: z.string().max(2000),
  approvedCopy: z.string().max(4000), rules: z.array(z.string().max(2000)).max(100),
  designNotes: z.string().max(4000).optional(), styleReferenceName: z.string().min(1).max(255).optional(),
}).strict().refine(facts => new TextEncoder().encode(JSON.stringify(facts)).length <= 24 * 1024,
  { message: "简报输入超过 24 KiB" });
export type SolPosterModelInput = z.infer<typeof SolPosterModelInput>;
export const SolPosterModelReply = z.object({
  choices: SolPosterChoices, model: z.string().min(1), totalTokens: z.number().int().nonnegative().optional(),
}).strict();
export const SolPosterReceipt = z.object({
  imageRequestId: z.string().regex(/^sgr_[a-f0-9]{32}$/).optional(),
  conversation: z.object({message:z.string(), designNotes:z.string().optional(), audience:z.string(), question:z.string().nullable(),
    resumed:z.boolean(), reusedDirection:z.boolean()}).optional(),
  id: z.string(), mutationId: z.string().uuid(), product: z.string(), brand: z.string(), createdAt: z.string(),
  styleReference: z.object({assetId: NativeProjectQueryInput.shape.projectId, name: z.string()}).optional(),
  target: StudioWorkflowTarget, contextRevision: z.number(), documentRevision: z.number(),
  status: z.enum(["PENDING","RUNNING","FAILED","SUCCEEDED"]), error: z.string().nullable(),
  result: z.object({ choices: SolPosterChoices, approvedCopy: z.string(), visualRequirements: z.string(),
    rules: z.array(z.string()) }).strict().nullable(),
});
export type SolPosterReceipt = z.infer<typeof SolPosterReceipt>;

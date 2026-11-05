import { z } from 'zod';
export const InspirationReceiptPreflightInput=z.object({sha256:z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(1000)}).strict();
export const InspirationReceiptPolicyInput=z.discriminatedUnion('action',[
  z.object({action:z.literal('initialize'),ownerId:z.string().min(1).max(128)}).strict(),
  z.object({action:z.literal('promote'),ownerId:z.string().min(1).max(128),qualityDay:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),qualityEvidence:z.string().trim().min(10).max(2000)}).strict(),
]);
export const InspirationReceiptDailyResult=z.object({
  schema_version:z.literal(1),timezone:z.literal('Asia/Shanghai'),day:z.string(),enabled:z.boolean(),initialized:z.boolean(),
  started_at:z.string().nullable(),start_day:z.string().nullable(),metric:z.literal('first_successful_unique_image_sha256'),
  received:z.number().int().nonnegative(),target:z.number().int().nullable(),remaining:z.number().int().nonnegative().nullable(),
  baseline_count:z.number().int().nonnegative(),receipt_revision:z.string().nullable(),baseline_revision:z.string().nullable(),
  human_reviewed:z.null(),quality_review:z.object({day:z.string(),reviewed_at:z.string().nullable()}).nullable(),notice:z.string(),
});
export const InspirationReceiptPreflightResult=InspirationReceiptDailyResult.extend({known_sha256:z.array(z.string()),new_unique_images:z.number().int().nonnegative(),fits:z.boolean(),advisory:z.literal(true),atomic_package_required:z.literal(true)});

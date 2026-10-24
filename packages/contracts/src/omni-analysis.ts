import { z } from 'zod';

/** Single-image service contract. No permissions, review state or provider secrets cross this boundary. */
export const OmniAnalysisInput = z.object({
  request_id: z.string().regex(/^(?:[0-9a-fA-F]{16,64}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/),
  source_image_id: z.string().min(1).max(128),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  image_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  image_base64: z.string().min(4).max(1398104).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  title: z.string().max(500),
  description: z.string().max(2000),
}).strict();
export type OmniAnalysisInput = z.infer<typeof OmniAnalysisInput>;
const DesignText = z.string().max(1500);
const SuggestionFields = z.object({
  purposes: z.array(z.enum(['brand','conversion'])).max(2).refine(v => new Set(v).size === v.length),
  kind: z.enum(['advertisement','reference','uncertain']),
  reason: z.string().max(1500).refine(value => value.trim().length > 0, 'Analysis reason is required'), description: z.string().max(3000),
  ocr_text: z.string().max(6000), brand: z.string().max(200),
  design: z.object({ palette:DesignText, typography:DesignText, composition:DesignText,
    hierarchy:DesignText, imagery:DesignText, reusable_ideas:DesignText,
    applicability:DesignText, limitations:DesignText }).strict(),
}).strict();
const validPurposes = (value:{kind:string;purposes:string[]}) => value.kind !== 'advertisement' || value.purposes.length > 0;
export const OmniAnalysisSuggestion = SuggestionFields.refine(validPurposes, 'Advertisement requires a purpose');
export const OmniAnalysisResult = SuggestionFields.extend({ model_version:z.string().min(1).max(200).refine(value => value.trim().length > 0) }).refine(validPurposes, 'Advertisement requires a purpose');
export type OmniAnalysisResult = z.infer<typeof OmniAnalysisResult>;
export const OmniAnalysisJob = z.object({ id:z.string(), status:z.enum(['queued','running','completed','failed']),
  reason:z.string(), result:OmniAnalysisResult.optional() }).strict();
export const OmniAnalysisConfig = z.object({ready:z.boolean(),state:z.string(),model:z.string(),daily_limit:z.number().int().nonnegative()}).strict();

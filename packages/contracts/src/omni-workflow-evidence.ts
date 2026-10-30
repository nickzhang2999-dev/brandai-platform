import { z } from 'zod';
import { OmniAnalysisInput } from './omni-analysis';
import { OmniAssetIdentity } from './omni-asset-workflow';

/** A persisted declaration from an authenticated analysis request. It is not
 * proof of the current Omni asset revision, rights, review or publication. */
export const OmniAnalysisSourceEvidence = OmniAssetIdentity.extend({ request_id: OmniAnalysisInput.shape.request_id }).strict();
export type OmniAnalysisSourceEvidence = z.infer<typeof OmniAnalysisSourceEvidence>;
export const OmniWorkflowEvidenceGap = z.enum(['source_identity', 'current_source', 'model_identity', 'ai_review', 'human_review', 'permissions', 'publication']);
export const OmniAnalysisWorkflowEvidence = z.object({
  schema_version: z.literal(1),
  job_id: z.string().min(1).max(128).refine(value => !!value.trim()),
  source: OmniAnalysisSourceEvidence.nullable(),
  source_basis: z.enum(['authenticated_request', 'unavailable']),
  analysis: z.object({ status: z.enum(['queued', 'running', 'completed', 'failed', 'unknown']),
    model_version: z.string().min(1).max(200).refine(value => !!value.trim()).nullable(), expired: z.boolean() }).strict(),
  ai_review: z.literal('unknown'), human_review: z.literal('unknown'),
  permissions: z.object({ analysis: z.literal('unknown'), display: z.literal('unknown'), export: z.literal('unknown') }).strict(),
  publication: z.literal('unknown'), workflow: z.null(), eligible_for_publication: z.literal(false),
  missing_evidence: z.array(OmniWorkflowEvidenceGap).max(7),
}).strict().superRefine((value, context) => {
  const gaps = new Set(value.missing_evidence);
  if (gaps.size !== value.missing_evidence.length
    || ['current_source', 'ai_review', 'human_review', 'permissions', 'publication'].some(gap => !gaps.has(gap as z.infer<typeof OmniWorkflowEvidenceGap>))
    || (value.source === null) !== (value.source_basis === 'unavailable')
    || (value.source === null) !== gaps.has('source_identity')
    || (value.analysis.model_version === null) !== gaps.has('model_identity')
    || (value.analysis.status !== 'completed' && value.analysis.model_version !== null)) {
    context.addIssue({ code: 'custom', message: 'Evidence must preserve unknown review, rights and current-source gaps' });
  }
});
export type OmniAnalysisWorkflowEvidence = z.infer<typeof OmniAnalysisWorkflowEvidence>;

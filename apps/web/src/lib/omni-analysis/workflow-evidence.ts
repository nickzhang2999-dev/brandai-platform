import { OmniAnalysisInput, OmniAnalysisResult, OmniAnalysisSourceEvidence, OmniAnalysisWorkflowEvidence } from '@brandai/contracts';
import type { z } from 'zod';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** No title, prompt, image bytes, service actor or permissions enter this snapshot. */
export function snapshotOmniAnalysisSource(input: OmniAnalysisInput) {
  const parsed = OmniAnalysisSourceEvidence.safeParse({ request_id: input.request_id, asset_id: input.source_image_id,
    revision: input.revision, sha256: input.image_sha256 });
  // Do not tighten old admission semantics merely to fill an evidence field.
  return parsed.success ? parsed.data : null;
}

/** Terminal retention is an allowlist; historical stripped jobs stay unknown. */
export function retainedOmniAnalysisMetadata(raw: unknown) {
  const meta = object(raw), source = OmniAnalysisSourceEvidence.safeParse(meta.source_identity);
  return { payload_hash: typeof meta.payload_hash === 'string' ? meta.payload_hash : '',
    user_id: typeof meta.user_id === 'string' ? meta.user_id : '', ...(source.success ? { source_identity: source.data } : {}) };
}

/** No side effects, freshness claims or inferred human decisions. */
export function omniWorkflowEvidence(task: { id: string; status: string; inputJson: unknown; resultJson: unknown; expiresAt: Date | null }, now = new Date()) {
  const source = OmniAnalysisSourceEvidence.safeParse(object(task.inputJson).source_identity);
  const status = ({ PENDING: 'queued', RUNNING: 'running', SUCCEEDED: 'completed', FAILED: 'failed' } as const)[task.status as 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'] ?? 'unknown';
  const result = status === 'completed' ? OmniAnalysisResult.safeParse(task.resultJson) : null;
  const model = result?.success ? result.data.model_version : null;
  const missing: z.infer<typeof OmniAnalysisWorkflowEvidence>['missing_evidence'] = ['current_source', 'ai_review', 'human_review', 'permissions', 'publication'];
  if (!source.success) missing.unshift('source_identity');
  if (!model) missing.push('model_identity');
  return OmniAnalysisWorkflowEvidence.parse({ schema_version: 1, job_id: task.id, source: source.success ? source.data : null,
    source_basis: source.success ? 'authenticated_request' : 'unavailable',
    analysis: { status, model_version: model, expired: !!task.expiresAt && task.expiresAt <= now && ['queued', 'running'].includes(status) },
    ai_review: 'unknown', human_review: 'unknown', permissions: { analysis: 'unknown', display: 'unknown', export: 'unknown' },
    publication: 'unknown', workflow: null, eligible_for_publication: false, missing_evidence: missing });
}

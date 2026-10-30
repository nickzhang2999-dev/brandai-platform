import { describe, expect, it } from 'vitest';
import { OmniAnalysisWorkflowEvidence } from '../src/omni-workflow-evidence';

const evidence = () => ({ schema_version: 1, job_id: 'job-1', source: null, source_basis: 'unavailable',
  analysis: { status: 'completed', model_version: 'configured-model', expired: false }, ai_review: 'unknown', human_review: 'unknown',
  permissions: { analysis: 'unknown', display: 'unknown', export: 'unknown' }, publication: 'unknown', workflow: null, eligible_for_publication: false,
  missing_evidence: ['source_identity', 'current_source', 'ai_review', 'human_review', 'permissions', 'publication'] });
describe('Omni read-only workflow evidence', () => {
  it('accepts model execution with unknown historical identity without creating a workflow', () => {
    expect(OmniAnalysisWorkflowEvidence.parse(evidence())).toMatchObject({ source: null, workflow: null, eligible_for_publication: false });
  });
  it.each([{ eligible_for_publication: true }, { eligible_for_publication: 0 }, { schema_version: true }, { publication: 'draft' },
    { human_review: 'approved' }, { ai_review: 'accept' }, { workflow: {} }, { source_basis: 'authenticated_request' },
    { missing_evidence: ['source_identity'] }, { user_id: 'forbidden-user' }, { analysis: { status: 'running', model_version: 'unproven-model', expired: false } }])('rejects fabricated approval or inconsistent evidence %#', patch => {
    expect(OmniAnalysisWorkflowEvidence.safeParse({ ...evidence(), ...patch }).success).toBe(false);
  });
  it('binds a known declaration without claiming freshness or publication', () => {
    const value = { ...evidence(), source: { request_id: '1234567890abcdef', asset_id: 'asset-1', revision: 2, sha256: 'a'.repeat(64) },
      source_basis: 'authenticated_request', missing_evidence: evidence().missing_evidence.filter(gap => gap !== 'source_identity') };
    expect(OmniAnalysisWorkflowEvidence.parse(value).missing_evidence).toContain('current_source');
  });
});

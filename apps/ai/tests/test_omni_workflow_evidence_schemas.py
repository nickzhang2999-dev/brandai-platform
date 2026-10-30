from copy import deepcopy
import pytest
from pydantic import ValidationError
from app.omni_workflow_evidence_schemas import OmniAnalysisWorkflowEvidence


def evidence():
    return {'schema_version': 1, 'job_id': 'job-1', 'source': None, 'source_basis': 'unavailable',
            'analysis': {'status': 'completed', 'model_version': 'configured-model', 'expired': False},
            'ai_review': 'unknown', 'human_review': 'unknown',
            'permissions': {'analysis': 'unknown', 'display': 'unknown', 'export': 'unknown'},
            'publication': 'unknown', 'workflow': None, 'eligible_for_publication': False,
            'missing_evidence': ['source_identity', 'current_source', 'ai_review', 'human_review', 'permissions', 'publication']}


def test_historical_evidence_has_no_invented_source_or_approval():
    value = evidence()
    assert OmniAnalysisWorkflowEvidence.model_validate(deepcopy(value)).model_dump() == value


@pytest.mark.parametrize('patch', [{'eligible_for_publication': True}, {'eligible_for_publication': 0}, {'schema_version': True},
    {'publication': 'draft'}, {'human_review': 'approved'}, {'ai_review': 'accept'}, {'workflow': {}},
    {'source_basis': 'authenticated_request'}, {'missing_evidence': ['source_identity']}, {'user_id': 'forbidden-user'},
    {'analysis': {'status': 'running', 'model_version': 'unproven-model', 'expired': False}}])
def test_rejects_fabricated_approval_or_inconsistent_evidence(patch):
    with pytest.raises(ValidationError):
        OmniAnalysisWorkflowEvidence.model_validate({**evidence(), **patch})


def test_known_source_is_only_a_declaration_not_freshness():
    value = evidence()
    value.update(source={'request_id': '1234567890abcdef', 'asset_id': 'asset-1', 'revision': 2, 'sha256': 'a' * 64}, source_basis='authenticated_request')
    value['missing_evidence'].remove('source_identity')
    assert 'current_source' in OmniAnalysisWorkflowEvidence.model_validate(value).missing_evidence

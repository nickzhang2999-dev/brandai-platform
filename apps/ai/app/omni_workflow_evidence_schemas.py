"""Read-only evidence mirror. Unknown review/rights must never become a grant."""
from typing import Literal
from pydantic import Field, model_validator
from .omni_analysis_schemas import StrictModel
from .omni_asset_workflow_schemas import OmniAssetIdentity, Id, Version


class OmniAnalysisSourceEvidence(OmniAssetIdentity):
    request_id: str = Field(pattern=r'^(?:[0-9a-fA-F]{16,64}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$')


class ExecutionEvidence(StrictModel):
    status: Literal['queued', 'running', 'completed', 'failed', 'unknown']
    model_version: Version | None
    expired: bool


class UnknownPermissions(StrictModel):
    analysis: Literal['unknown']
    display: Literal['unknown']
    export: Literal['unknown']


EvidenceGap = Literal['source_identity', 'current_source', 'model_identity', 'ai_review', 'human_review', 'permissions', 'publication']


class OmniAnalysisWorkflowEvidence(StrictModel):
    schema_version: Literal[1]
    job_id: Id
    source: OmniAnalysisSourceEvidence | None
    source_basis: Literal['authenticated_request', 'unavailable']
    analysis: ExecutionEvidence
    ai_review: Literal['unknown']
    human_review: Literal['unknown']
    permissions: UnknownPermissions
    publication: Literal['unknown']
    workflow: None
    eligible_for_publication: Literal[False]
    missing_evidence: list[EvidenceGap] = Field(max_length=7)

    @model_validator(mode='before')
    @classmethod
    def strict_constants(cls, value):
        if isinstance(value, dict) and (type(value.get('schema_version')) is not int or type(value.get('eligible_for_publication')) is not bool):
            raise ValueError('Evidence constants must have exact types')
        return value

    @model_validator(mode='after')
    def preserve_gaps(self):
        gaps = set(self.missing_evidence)
        if (len(gaps) != len(self.missing_evidence)
                or not {'current_source', 'ai_review', 'human_review', 'permissions', 'publication'} <= gaps
                or (self.source is None) != (self.source_basis == 'unavailable')
                or (self.source is None) != ('source_identity' in gaps)
                or (self.analysis.model_version is None) != ('model_identity' in gaps)
                or (self.analysis.status != 'completed' and self.analysis.model_version is not None)):
            raise ValueError('Evidence must preserve unknown review, rights and current-source gaps')
        return self

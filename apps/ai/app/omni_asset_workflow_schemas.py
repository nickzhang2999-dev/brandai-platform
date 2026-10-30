"""Reserved Omni adapter contract. No routes, scheduling or publication effects."""
from typing import Annotated, Literal
from pydantic import BeforeValidator, Field, model_validator
from .omni_analysis_schemas import StrictModel
from .studio_decomposition_schemas import _DATE, _TIME, _JS_WHITESPACE, _utf16_length

def text(value, limit):
    if not isinstance(value, str) or not value.strip(_JS_WHITESPACE) or _utf16_length(value) > limit:
        raise ValueError("Invalid bounded text")
    return value

Id = Annotated[str, BeforeValidator(lambda value: text(value, 128))]
Version = Annotated[str, BeforeValidator(lambda value: text(value, 200))]
Permission = Literal["allowed", "denied", "unknown"]
JobStatus = Literal["not_requested", "queued", "running", "completed", "failed"]

class OmniAssetIdentity(StrictModel):
    asset_id: Id
    revision: int = Field(gt=0, le=9007199254740991)
    sha256: str = Field(pattern=r"^[a-f0-9]{64}\z")

class Analysis(StrictModel):
    status: JobStatus
    job_id: Id | None
    model_version: Version | None

class AiReview(StrictModel):
    status: JobStatus
    suggestion: Literal["accept", "reject", "needs_human"] | None
    policy_version: Version | None
    job_id: Id | None

class PendingReview(StrictModel):
    status: Literal["unknown", "pending"]
    reviewer_id: None
    decided_at: None

class DecidedReview(StrictModel):
    status: Literal["approved", "rejected"]
    reviewer_id: Id
    decided_at: str = Field(pattern=rf"^{_DATE}T{_TIME}(Z|[+-][0-9]{{2}}:?[0-9]{{2}})\z")

class Permissions(StrictModel):
    analysis: Permission
    display: Permission
    export: Permission

class OmniAssetWorkflow(StrictModel):
    schema_version: Literal[1]
    source: OmniAssetIdentity
    analysis: Analysis
    ai_review: AiReview
    human_review: Annotated[PendingReview | DecidedReview, Field(discriminator="status")]
    permissions: Permissions
    publication: Literal["draft", "published", "withdrawn"]

    @model_validator(mode="before")
    @classmethod
    def exact_version(cls, value):
        if isinstance(value, dict) and type(value.get("schema_version")) is not int:
            raise ValueError("Version must be an integer")
        return value

    @model_validator(mode="after")
    def execution_evidence(self):
        a, r = self.analysis, self.ai_review
        if ((a.status != "not_requested" and not a.job_id)
                or (a.status == "not_requested" and (a.job_id is not None or a.model_version is not None))
                or (a.status == "completed" and not a.model_version)):
            raise ValueError("Analysis requires its persisted job and completed model identity")
        if ((r.status == "not_requested" and (r.job_id is not None or r.policy_version is not None))
                or (r.status != "not_requested" and (not r.job_id or not r.policy_version))
                or (r.status == "completed") != (r.suggestion is not None)):
            raise ValueError("AI review suggestions require a completed policy-versioned job")
        return self

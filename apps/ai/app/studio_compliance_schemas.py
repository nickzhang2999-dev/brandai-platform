"""Strict BFF compliance task mirror; this does not add a provider endpoint."""
from datetime import datetime
from typing import Literal
from pydantic import BaseModel, Field, field_validator, model_validator
from .studio_workflow_schemas import StrictModel, ProjectId, Sha256

Level = Literal["PASS", "RISK", "FORBIDDEN"]

class StudioComplianceResult(BaseModel):
    model_config = {"strict": True}
    level: Level
    reason: str
    span: str | None = None
    replacement: str | None = None
    category: Literal["ABSOLUTE", "EFFICACY", "EXAGGERATION", "AUTHORITY", "BRAND_TERM", "BRAND_VISUAL", "PLATFORM"] | None = None

    @model_validator(mode="before")
    @classmethod
    def no_optional_null(cls, value):
        if isinstance(value, dict) and any(key in value and value[key] is None for key in ("span", "replacement", "category")):
            raise ValueError("Optional result fields must be omitted, not null")
        return value

class StudioComplianceReport(BaseModel):
    model_config = {"strict": True}
    overall: Level
    textResults: list[StudioComplianceResult] = Field(default_factory=list)
    visualResults: list[StudioComplianceResult] = Field(default_factory=list)
    checkedAt: str
    score: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)

    @model_validator(mode="before")
    @classmethod
    def no_score_null(cls, value):
        if isinstance(value, dict) and "score" in value and value["score"] is None:
            raise ValueError("Optional score must be omitted, not null")
        return value

class StudioGenerationComplianceInput(StrictModel):
    projectId: ProjectId
    versionId: ProjectId

StudioGenerationComplianceQuery = StudioGenerationComplianceInput

class StudioGenerationComplianceView(StrictModel):
    taskId: ProjectId | None
    versionId: ProjectId
    status: Literal["NOT_REQUESTED", "PENDING", "RUNNING", "SUCCEEDED", "FAILED"]
    progress: int = Field(ge=0, le=100)
    expiresAt: str | None
    checkedImageSha256: Sha256 | None
    report: StudioComplianceReport | None
    error: str | None
    canRetry: bool

    @field_validator("expiresAt")
    @classmethod
    def valid_deadline(cls, value):
        if value is not None:
            if not value.endswith("Z"):
                raise ValueError("UTC ISO timestamp required")
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value

    @model_validator(mode="after")
    def checked_state(self):
        if self.status == "SUCCEEDED":
            if self.report is None or self.checkedImageSha256 is None:
                raise ValueError("Completed check requires a real report and digest")
        elif self.report is not None or self.checkedImageSha256 is not None:
            raise ValueError("Incomplete checks cannot expose a previous report")
        if self.status == "FAILED" and not self.error:
            raise ValueError("Failed check requires a readable reason")
        if self.status == "NOT_REQUESTED":
            if self.taskId is not None or self.expiresAt is not None:
                raise ValueError("No task means no task identity/deadline")
        elif self.taskId is None or self.expiresAt is None:
            raise ValueError("Task identity/deadline required")
        return self

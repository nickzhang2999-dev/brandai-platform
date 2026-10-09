"""Product generation receipt mirror. It does not expose an AI endpoint."""
from datetime import datetime
from typing import Annotated, Literal
from pydantic import Field, field_validator, model_validator
from .studio_workflow_schemas import StrictModel, ProjectId, Sha256

MutationId = Annotated[str, Field(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z")]

class StudioCustomRatio(StrictModel):
    width: float = Field(gt=0, le=10000, allow_inf_nan=False)
    height: float = Field(gt=0, le=10000, allow_inf_nan=False)

class StudioGenerationSizeSelection(StrictModel):
    ratioKey: Literal["1:1", "4:5", "3:4", "2:3", "9:16", "5:4", "4:3", "3:2", "16:10", "16:9", "2.35:1", "3:1", "custom"]
    resolutionTier: Literal["1K", "2K"]
    customRatio: StudioCustomRatio | None = None

    @model_validator(mode="before")
    @classmethod
    def no_explicit_null(cls, value):
        if isinstance(value, dict) and "customRatio" in value and value["customRatio"] is None:
            raise ValueError("customRatio must be omitted, not null")
        return value

    @model_validator(mode="after")
    def correct_ratio(self):
        if (self.ratioKey == "custom") != (self.customRatio is not None):
            raise ValueError("custom ratio and key must agree")
        if self.customRatio and not 1/3 <= self.customRatio.width / self.customRatio.height <= 3:
            raise ValueError("ratio outside supported range")
        return self

class StudioGenerationInput(StrictModel):
    projectId: ProjectId
    mutationId: MutationId
    prompt: str = Field(min_length=1, max_length=4000)
    sizeSelection: StudioGenerationSizeSelection
    workflowRevision: int = Field(ge=0, le=2147483646)
    documentRevision: int = Field(ge=0, le=2147483646)

    @field_validator("prompt", mode="before")
    @classmethod
    def trim_prompt(cls, value):
        return value.strip() if isinstance(value, str) else value

class StudioGenerationQuery(StrictModel):
    projectId: ProjectId
    requestId: ProjectId | None = None

    @model_validator(mode="before")
    @classmethod
    def no_explicit_null(cls, value):
        if isinstance(value, dict) and "requestId" in value and value["requestId"] is None:
            raise ValueError("requestId must be omitted, not null")
        return value

class StudioGenerationRetryInput(StrictModel):
    projectId: ProjectId
    requestId: ProjectId

StudioGenerationArchiveRetryInput = StudioGenerationRetryInput

class StudioGenerationResult(StrictModel):
    versionId: ProjectId
    assetId: ProjectId
    assetSha256: Sha256
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    mimeType: Literal["image/png", "image/jpeg", "image/webp"]
    url: str = Field(pattern=r"^/api/workspaces/[a-zA-Z0-9_-]+/assets/[a-zA-Z0-9_-]+/raw\z")

class StudioGenerationView(StrictModel):
    requestId: ProjectId
    mutationId: MutationId
    projectId: ProjectId
    generationId: ProjectId
    status: Literal["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]
    progress: None
    expiresAt: str
    archiveExpiresAt: str | None
    archiveProcessingExpiresAt: str | None
    displayText: str
    resultState: Literal["NOT_REQUESTED", "PENDING", "RUNNING", "READY", "FAILED"]
    results: list[StudioGenerationResult]
    error: str | None
    archiveError: str | None
    canRetryArchive: bool

    @field_validator("expiresAt", "archiveExpiresAt", "archiveProcessingExpiresAt")
    @classmethod
    def valid_datetime(cls, value):
        if value is not None:
            if not value.endswith("Z"):
                raise ValueError("UTC ISO timestamp required")
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value

"""Mirror of receiver-only contracts/inspiration-receipts.ts; no AI endpoint is added."""
from typing import Annotated, Literal, Union
from pydantic import BaseModel, ConfigDict, Field, field_validator

class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

class InspirationReceiptPreflightInput(StrictModel):
    sha256: list[Annotated[str, Field(pattern=r'^[0-9a-f]{64}$')]] = Field(max_length=1000)

class InspirationReceiptInitializeInput(StrictModel):
    action: Literal['initialize']
    ownerId: str = Field(min_length=1, max_length=128)

class InspirationReceiptPromoteInput(StrictModel):
    action: Literal['promote']
    ownerId: str = Field(min_length=1, max_length=128)
    qualityDay: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    qualityEvidence: str = Field(min_length=10, max_length=2000)

    @field_validator('qualityEvidence', mode='before')
    @classmethod
    def trim_evidence(cls, value):
        return value.strip() if isinstance(value, str) else value

InspirationReceiptPolicyInput = Annotated[Union[InspirationReceiptInitializeInput, InspirationReceiptPromoteInput], Field(discriminator='action')]

class InspirationReceiptQualityReview(StrictModel):
    day: str
    reviewed_at: str | None

class InspirationReceiptDailyResult(StrictModel):
    schema_version: Literal[1]
    timezone: Literal['Asia/Shanghai']
    day: str
    enabled: bool
    initialized: bool
    started_at: str | None
    start_day: str | None
    metric: Literal['first_successful_unique_image_sha256']
    received: int = Field(ge=0)
    target: int | None
    remaining: Annotated[int, Field(ge=0)] | None
    baseline_count: int = Field(ge=0)
    receipt_revision: str | None
    baseline_revision: str | None
    human_reviewed: None
    quality_review: InspirationReceiptQualityReview | None
    notice: str

class InspirationReceiptPreflightResult(InspirationReceiptDailyResult):
    known_sha256: list[str]
    new_unique_images: int = Field(ge=0)
    fits: bool
    advisory: Literal[True]
    atomic_package_required: Literal[True]

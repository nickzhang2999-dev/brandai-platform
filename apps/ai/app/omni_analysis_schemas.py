"""Mirrors contracts/omni-analysis.ts; private BFF service, not an AI HTTP endpoint."""
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

class OmniAnalysisInput(StrictModel):
    request_id: str = Field(pattern=r'^(?:[0-9a-fA-F]{16,64}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$')
    source_image_id: str = Field(min_length=1, max_length=128)
    revision: int = Field(gt=0, le=9007199254740991)
    image_sha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    image_base64: str = Field(min_length=4, max_length=1398104, pattern=r'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$')
    title: str = Field(max_length=500)
    description: str = Field(max_length=2000)

DesignText = Annotated[str, Field(max_length=1500)]
class OmniAnalysisDesign(StrictModel):
    palette: DesignText
    typography: DesignText
    composition: DesignText
    hierarchy: DesignText
    imagery: DesignText
    reusable_ideas: DesignText
    applicability: DesignText
    limitations: DesignText

class OmniAnalysisSuggestion(StrictModel):
    purposes: list[Literal['brand','conversion']] = Field(max_length=2)
    kind: Literal['advertisement','reference','uncertain']
    reason: str = Field(max_length=1500)
    description: str = Field(max_length=3000)
    ocr_text: str = Field(max_length=6000)
    brand: str = Field(max_length=200)
    design: OmniAnalysisDesign

    @field_validator('purposes')
    @classmethod
    def unique_purposes(cls, value):
        if len(value) != len(set(value)):
            raise ValueError('Duplicate purpose')
        return value

    @field_validator('reason')
    @classmethod
    def meaningful_reason(cls, value):
        if not value.strip():
            raise ValueError('Analysis reason is required')
        return value

    @model_validator(mode='after')
    def advertisement_purpose(self):
        if self.kind == 'advertisement' and not self.purposes:
            raise ValueError('Advertisement requires a purpose')
        return self

class OmniAnalysisResult(OmniAnalysisSuggestion):
    model_version: str = Field(min_length=1, max_length=200)

    @field_validator('model_version')
    @classmethod
    def meaningful_model(cls, value):
        if not value.strip():
            raise ValueError('Model identifier is required')
        return value

class OmniAnalysisJob(StrictModel):
    id: str
    status: Literal['queued','running','completed','failed']
    reason: str
    result: OmniAnalysisResult | None = None

    @field_validator('result', mode='before')
    @classmethod
    def omitted_not_null(cls, value):
        if value is None:
            raise ValueError('Omit result instead of null')
        return value

class OmniAnalysisConfig(StrictModel):
    ready: bool
    state: str
    model: str
    # Required nullable field: null is unlimited, zero is disabled.
    daily_limit: int | None = Field(ge=0)

"""BFF/worker copywriting contract mirror; no public AI route or secrets."""
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, model_validator

class CopywritingImage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    assetId: str = Field(min_length=1, max_length=128)
    assetSha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")

class StudioCopywritingInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    mutationId: UUID
    prompt: str = Field(min_length=1, max_length=2000)
    mode: Literal["GENERATE", "REWRITE"] = "GENERATE"
    sourceText: str = Field(default="", max_length=4000)
    tone: Literal["自然", "简洁", "活泼", "专业"] = "自然"
    image: CopywritingImage | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_null_image(cls, value):
        if isinstance(value, dict) and "image" in value and value["image"] is None:
            raise ValueError("Omit image instead of sending null")
        return value

    @model_validator(mode="after")
    def require_source(self):
        if self.mode == "REWRITE" and not self.sourceText:
            raise ValueError("Rewrite requires source text")
        return self

class StudioCopywritingCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=100)
    body: str = Field(min_length=1, max_length=1000)

class StudioCopywritingResult(BaseModel):
    candidates: list[StudioCopywritingCandidate] = Field(min_length=1, max_length=3)
    model: str
    inputTokens: int = Field(ge=0)
    outputTokens: int = Field(ge=0)
    latencyMs: int = Field(ge=0)

"""Mirrors packages/contracts/src/visual-fidelity.ts."""
from typing import Annotated, Literal
from pydantic import BaseModel, Field, StringConstraints, model_validator

Text = Annotated[str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=4000)]
Sha256 = Annotated[str, StringConstraints(strict=True, pattern=r"^[a-f0-9]{64}$")]

class StrictModel(BaseModel):
    model_config = {"extra": "forbid"}

    @model_validator(mode="before")
    @classmethod
    def no_null(cls, value):
        if isinstance(value, dict) and any(v is None for v in value.values()):
            raise ValueError("Optional fields must be omitted, not null")
        return value

class VisualFidelityConstraint(StrictModel):
    id: Text
    target: Text
    attribute: Text
    expected: Text
    strength: Literal["hard", "soft"]
    source: Literal["user", "brand", "source"]

class VisualFidelityPlan(StrictModel):
    revision: Literal["visual-fidelity-guard/1"]
    inputSha256: Sha256
    constraints: list[VisualFidelityConstraint] = Field(max_length=64)

    @model_validator(mode="after")
    def unique_ids(self):
        if len({c.id for c in self.constraints}) != len(self.constraints):
            raise ValueError("Duplicate constraint IDs")
        return self

class VisualFidelitySourceImage(StrictModel):
    id: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=128)] | None = None
    role: Literal["edit-source", "reference-context"] | None = None
    note: Annotated[str, StringConstraints(strict=True, max_length=4000)] | None = None
    url: Annotated[str, StringConstraints(strict=True, min_length=1)]
    sha256: Sha256
    sourceHint: Literal["UPLOAD", "WEBSITE"] | None = None

class VisualFidelityCheck(StrictModel):
    id: Text
    status: Literal["pass", "fail", "unknown"]
    objectRegion: Text | None = None
    observation: Text
    evidence: Text

class VisualFidelityReport(StrictModel):
    revision: Literal["visual-fidelity-guard/1"]
    inputSha256: Sha256
    outputSha256: Sha256
    overall: Literal["pass", "fail", "unknown", "not_applicable"]
    checkPerformed: bool = Field(strict=True)
    checks: list[VisualFidelityCheck]
    warnings: list[Text]

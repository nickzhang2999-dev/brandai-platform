"""Read-only current state and frozen historical evidence; no AI endpoint."""
from typing import Literal
from pydantic import Field
from .studio_workflow_schemas import StrictModel


class StudioBrandRuleStatus(StrictModel):
    workspaceId: str = Field(min_length=1)
    brandName: str
    applicationEnabled: bool = Field(strict=True)
    confirmedCount: int = Field(ge=0, strict=True)
    draftCount: int = Field(ge=0, strict=True)
    savedDraftAvailable: bool = Field(strict=True)


class StudioAppliedBrandRule(StrictModel):
    id: str = Field(min_length=1)
    type: str
    summary: str
    strength: str


class StudioBrandColourMatch(StrictModel):
    hex: str
    share: float
    closestDetected: str
    deltaE: float


class StudioDetectedColour(StrictModel):
    hex: str
    share: float


class StudioBrandColourFidelity(StrictModel):
    checked: bool = Field(strict=True)
    present: list[StudioBrandColourMatch]
    missing: list[str]
    neutral: list[str] = Field(default_factory=list)
    detected: list[StudioDetectedColour]
    withinBrand: bool = Field(strict=True)


class StudioBrandRuleReceipt(StrictModel):
    outputId: str = Field(min_length=1)
    appliedRuleCount: int | None = Field(ge=0, strict=True)
    mode: Literal["BRANDED", "FREE"] | None
    reason: Literal["APPLIED", "IMAGE_TOOL", "NO_APPLICABLE_RULES"] | None
    rules: list[StudioAppliedBrandRule]
    detailsComplete: bool = Field(strict=True)
    promptAdditionCount: int | None = Field(ge=0, strict=True)
    colourFidelity: StudioBrandColourFidelity | None = None

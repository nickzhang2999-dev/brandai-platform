"""Mirror of studio-layer-quality.ts; pixel triage only, no provider calls."""
from typing import Annotated, Literal
from pydantic import Field, model_validator
from .studio_workflow_schemas import StrictModel, Sha256

Dimension = Annotated[int, Field(gt=0, le=16384)]
Ratio = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
Difference = Annotated[float, Field(ge=0, le=255, allow_inf_nan=False)]
_DATE = r"(([0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|(02)-(0[1-9]|1[0-9]|2[0-8])))"
_TIME = r"([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?"
UtcDateTime = Annotated[str, Field(pattern=rf"^{_DATE}T{_TIME}Z\z")]
StudioLayerQualityWarning = Literal["COMPOSITE_DIFFERENCE", "LOCAL_DIFFERENCE", "WEAK_LAYER", "NEAR_DUPLICATE_LAYERS", "QUALITY_CHECK_UNAVAILABLE"]
StudioLayerQualityUnavailableReason = Literal["SOURCE_UNAVAILABLE", "SOURCE_MISMATCH", "SOURCE_INVALID", "CHECK_ABORTED", "CHECK_FAILED"]


class StudioLayerQualityMetrics(StrictModel):
    meanAbsoluteError: Difference
    changedPixelRatio: Ratio
    alphaMeanAbsoluteError: Difference


class StudioLayerQualityRegion(StrictModel):
    left: int = Field(ge=0)
    top: int = Field(ge=0)
    width: Dimension
    height: Dimension
    changedPixelRatio: Ratio


class StudioLayerQualityThresholds(StrictModel):
    changedChannelDelta: Literal[24]
    meanAbsoluteError: Literal[8]
    changedPixelRatio: Literal[0.05]
    alphaMeanAbsoluteError: Literal[8]
    regionChangedPixelRatio: Literal[0.1]


class StudioLayerQualityReport(StrictModel):
    revision: Literal["layer-quality-r1"]
    status: Literal["COMPOSITE_MATCH", "REVIEW_REQUIRED", "UNAVAILABLE"]
    sourceSha256: Sha256
    sourceWidth: Dimension
    sourceHeight: Dimension
    sampleWidth: int | None = Field(gt=0, le=1024)
    sampleHeight: int | None = Field(gt=0, le=1024)
    metrics: StudioLayerQualityMetrics | None
    regions: list[StudioLayerQualityRegion] = Field(max_length=16)
    thresholds: StudioLayerQualityThresholds
    warnings: list[StudioLayerQualityWarning] = Field(max_length=5)
    unavailableReason: StudioLayerQualityUnavailableReason | None
    semanticsChecked: Literal[False]
    textChecked: Literal[False]
    humanReviewRequired: Literal[True]
    checkedAt: UtcDateTime

    @model_validator(mode="after")
    def coherent_measurements(self):
        if self.status == "UNAVAILABLE":
            if not self.unavailableReason or self.metrics is not None or self.sampleWidth is not None or self.sampleHeight is not None or self.regions:
                raise ValueError("Unavailable quality requires an explicit reason and no measurements")
        elif self.unavailableReason is not None or self.metrics is None or self.sampleWidth is None or self.sampleHeight is None:
            raise ValueError("Quality status requires actual measurements")
        if ((self.sampleWidth is not None and self.sampleWidth > self.sourceWidth)
            or (self.sampleHeight is not None and self.sampleHeight > self.sourceHeight)
            or any(r.left + r.width > self.sourceWidth or r.top + r.height > self.sourceHeight for r in self.regions)):
            raise ValueError("Quality sampling and regions must stay within the source frame")
        global_difference = bool(self.metrics and (self.metrics.meanAbsoluteError > self.thresholds.meanAbsoluteError
            or self.metrics.changedPixelRatio > self.thresholds.changedPixelRatio
            or self.metrics.alphaMeanAbsoluteError > self.thresholds.alphaMeanAbsoluteError))
        if ((self.status == "COMPOSITE_MATCH" and (global_difference or self.regions or self.warnings))
            or (self.status == "REVIEW_REQUIRED" and not self.warnings)
            or (self.status != "UNAVAILABLE" and ("QUALITY_CHECK_UNAVAILABLE" in self.warnings
                or global_difference != ("COMPOSITE_DIFFERENCE" in self.warnings)
                or bool(self.regions) != ("LOCAL_DIFFERENCE" in self.warnings)))
            or (self.status == "UNAVAILABLE" and "QUALITY_CHECK_UNAVAILABLE" not in self.warnings)
            or any(r.changedPixelRatio <= self.thresholds.regionChangedPixelRatio for r in self.regions)):
            raise ValueError("Quality status and warnings must agree with versioned measurements")
        return self

"""Mirror of contracts/studio-decomposition.ts; no AI endpoint or provider calls."""
from typing import Annotated, Literal

from pydantic import Field, field_validator, model_validator

from .studio_workflow_schemas import StrictModel, ProjectId, Sha256
from .studio_layer_quality_schemas import StudioLayerQualityReport
from .studio_layer_assessment_schemas import LayerWorkflow

STUDIO_DECOMPOSITION_TTL_MS = 6 * 60_000
STUDIO_LAYER_RECOVERY_TTL_MS = 24 * 60 * 60_000
MutationId = Annotated[str, Field(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z")]
DecompositionShapeId = Annotated[str, Field(pattern=r"^shape:[A-Za-z0-9_-]{1,128}\z")]
Dimension = Annotated[int, Field(gt=0, le=16384)]
# Match Zod's default .datetime(): UTC Z only, optional seconds/fractions,
# and a valid Gregorian date (including its four-digit year syntax).
_DATE = r"(([0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-((0[13578]|1[02])-(0[1-9]|[12][0-9]|3[01])|(0[469]|11)-(0[1-9]|[12][0-9]|30)|(02)-(0[1-9]|1[0-9]|2[0-8])))"
_TIME = r"([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?"
UtcDateTime = Annotated[str, Field(pattern=rf"^{_DATE}T{_TIME}Z\z")]
_JS_WHITESPACE = " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


class StudioDecompositionInput(StrictModel):
    projectId: ProjectId
    mutationId: MutationId
    sourceShapeId: DecompositionShapeId
    assetId: ProjectId
    assetSha256: Sha256
    documentRevision: int = Field(ge=0)
    layerMode: Literal["AUTO", "MANUAL"] | None = None
    layerCount: int | None = Field(default=None, ge=2, le=10, strict=True)
    intent: str | None = Field(default=None, max_length=500)

    @model_validator(mode="before")
    @classmethod
    def no_null_intent(cls, value):
        if isinstance(value, dict):
            for key in ("intent", "layerMode", "layerCount"):
                if key in value and value[key] is None:
                    raise ValueError(f"{key} must be omitted, not null")
        return value

    @model_validator(mode="after")
    def correct_mode(self):
        if (self.layerMode == "AUTO" and self.layerCount is not None) or (self.layerMode != "AUTO" and self.layerCount is None):
            raise ValueError("AUTO chooses its own count; MANUAL requires a layer count")
        return self

    @field_validator("intent", mode="before")
    @classmethod
    def trim_intent(cls, value):
        if isinstance(value, str):
            value = value.strip(_JS_WHITESPACE)
            if _utf16_length(value) > 500:
                raise ValueError("intent exceeds 500 UTF-16 code units")
        return value


class StudioDecompositionQuery(StrictModel):
    projectId: ProjectId
    requestId: ProjectId | None = None

    @model_validator(mode="before")
    @classmethod
    def no_null_request(cls, value):
        if isinstance(value, dict) and "requestId" in value and value["requestId"] is None:
            raise ValueError("requestId must be omitted, not null")
        return value


class StudioDecompositionRetryInput(StudioDecompositionQuery):
    requestId: ProjectId


class StudioDecompositionAlphaBounds(StrictModel):
    left: int = Field(ge=0)
    top: int = Field(ge=0)
    width: Dimension
    height: Dimension


class StudioDecompositionLayer(StrictModel):
    assetId: ProjectId
    assetSha256: Sha256
    mimeType: Literal["image/png"]
    width: Dimension
    height: Dimension
    order: int = Field(ge=0, le=9)
    sizeBytes: int = Field(gt=0, le=32 * 1024 * 1024)
    url: str = Field(pattern=r"^/api/workspaces/[a-zA-Z0-9_-]{1,128}/assets/[a-zA-Z0-9_-]{1,128}/raw\z")
    alphaBounds: StudioDecompositionAlphaBounds
    inkCoverage: float = Field(ge=0, le=1, allow_inf_nan=False)
    name: str | None = Field(default=None, min_length=1, max_length=80)

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value):
        if value is None:
            raise ValueError("name must be omitted, not null")
        value = value.strip(_JS_WHITESPACE)
        if _utf16_length(value) > 80:
            raise ValueError("name exceeds 80 UTF-16 code units")
        return value

    @model_validator(mode="after")
    def within_full_frame(self):
        if self.alphaBounds.left + self.alphaBounds.width > self.width or self.alphaBounds.top + self.alphaBounds.height > self.height:
            raise ValueError("Alpha bounds exceed the original full image")
        return self


class StudioDecompositionView(StrictModel):
    requestId: ProjectId
    mutationId: MutationId
    projectId: ProjectId
    sourceShapeId: DecompositionShapeId
    assetId: ProjectId
    assetSha256: Sha256
    documentRevision: int = Field(ge=0)
    layerCount: int = Field(ge=2, le=10)
    requestedLayerCount: int | None = Field(default=None, ge=2, le=10)
    layerMode: Literal["AUTO", "MANUAL"] = "MANUAL"
    analysisStatus: Literal["NOT_REQUESTED", "PENDING", "RUNNING", "SUCCEEDED", "FAILED"] = "NOT_REQUESTED"
    analysisSummary: str | None = Field(default=None, max_length=600)
    sourceWidth: Dimension
    sourceHeight: Dimension
    status: Literal["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]
    error: str | None = Field(max_length=1000)
    createdAt: UtcDateTime
    expiresAt: UtcDateTime
    archiveExpiresAt: UtcDateTime | None
    canRetryArchive: bool
    layers: list[StudioDecompositionLayer] = Field(max_length=10)
    quality: StudioLayerQualityReport | None = None
    workflow: LayerWorkflow | None = None

    @field_validator("workflow", mode="before")
    @classmethod
    def no_null_workflow(cls, value):
        if value is None:
            raise ValueError("workflow must be omitted, not null")
        return value

    @field_validator("requestedLayerCount", mode="before")
    @classmethod
    def no_null_requested_count(cls, value):
        if value is None:
            raise ValueError("requestedLayerCount must be omitted, not null")
        return value

    @field_validator("error")
    @classmethod
    def bounded_error(cls, value):
        if value is not None and _utf16_length(value) > 1000:
            raise ValueError("error exceeds 1000 UTF-16 code units")
        return value

    @model_validator(mode="after")
    def only_complete_public_layers(self):
        if self.workflow and ((self.status == "SUCCEEDED") != (self.workflow.stage == "READY_FOR_REVIEW")
                or (self.status == "FAILED") != (self.workflow.stage == "FAILED")
                or (self.workflow.assessment is not None and (self.layerMode != "AUTO" or self.analysisStatus != "SUCCEEDED"))):
            raise ValueError("Workflow must reflect the actual saved task and successful scene analysis")
        if self.quality and (self.status != "SUCCEEDED" or self.quality.sourceSha256 != self.assetSha256
            or self.quality.sourceWidth != self.sourceWidth or self.quality.sourceHeight != self.sourceHeight):
            raise ValueError("Quality belongs only to its complete published source frame")
        if self.status != "SUCCEEDED" and self.requestedLayerCount is not None and self.requestedLayerCount != self.layerCount:
            raise ValueError("Unfinished layer receipts must retain the accepted count")
        if self.layerMode == "AUTO" and ((self.status == "SUCCEEDED" and (self.analysisStatus != "SUCCEEDED" or not self.analysisSummary)) or self.analysisStatus == "NOT_REQUESTED"):
            raise ValueError("AUTO requires real semantic analysis before publishing layers")
        if self.status != "SUCCEEDED" and self.layers:
            raise ValueError("Unpublished layers must stay private")
        if self.status == "SUCCEEDED" and (
            len(self.layers) < 2 or len(self.layers) != self.layerCount
            or any(layer.order != index or layer.width != self.sourceWidth or layer.height != self.sourceHeight for index, layer in enumerate(self.layers))
            or len({layer.assetId for layer in self.layers}) != len(self.layers)
        ):
            raise ValueError("Published layers need complete full-size ordered identities")
        return self

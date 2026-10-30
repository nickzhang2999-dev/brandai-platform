"""Scene proposals only: never infer tool authorization or completed repairs."""
from typing import Annotated, Literal
from pydantic import BeforeValidator, Field, model_validator
from .studio_workflow_schemas import StrictModel

_WS = " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

def bounded_text(value, limit):
    if not isinstance(value, str):
        raise ValueError("Expected text")
    value = value.strip(_WS)
    if not value or len(value.encode("utf-16-le", errors="surrogatepass")) // 2 > limit:
        raise ValueError("Text exceeds UTF-16 budget or is empty")
    return value

Description = Annotated[str, BeforeValidator(lambda value: bounded_text(value, 300))]
Target = Annotated[str, BeforeValidator(lambda value: bounded_text(value, 80))]

class LayerOcclusion(StrictModel):
    target: Target
    kind: Literal["CONTINUOUS_TEXTURE", "REGULAR_STRUCTURE", "IDENTITY_OR_PRODUCT", "TEXT_OR_LOGO", "ATTACHED_OBJECTS", "TRANSPARENCY_OR_REFLECTION"]
    evidence: Description
    action: Literal["INFER_BACKGROUND", "KEEP_GROUPED", "VISIBLE_ONLY", "REFERENCE_REQUIRED"]
    reason: Description

    @model_validator(mode="after")
    def constrain_inference(self):
        if self.action == "INFER_BACKGROUND" and self.kind not in {"CONTINUOUS_TEXTURE", "REGULAR_STRUCTURE"}:
            raise ValueError("Only ordinary background or regular structure may be inferred without a reference")
        return self

class LayerAssessment(StrictModel):
    occlusions: list[LayerOcclusion] = Field(max_length=8)
    preserve: list[Description] = Field(min_length=1, max_length=8)
    shadowPolicy: Literal["NONE_VISIBLE", "KEEP_WITH_SUBJECT", "SEPARATE_IF_VERIFIED", "KEEP_ENVIRONMENT", "UNCERTAIN"]
    shadowEvidence: Description

    @model_validator(mode="after")
    def unique_targets(self):
        if len({item.target for item in self.occlusions}) != len(self.occlusions):
            raise ValueError("Occlusion targets must be unique")
        return self

class LayerWorkflow(StrictModel):
    stage: Literal["QUEUED", "ANALYZING", "DECOMPOSING", "CHECKING_AND_SAVING", "READY_FOR_REVIEW", "FAILED"]
    assessment: LayerAssessment | None
    backgroundCompletion: Literal["NOT_PERFORMED"]
    independentQuality: Literal["NOT_REVIEWED"]

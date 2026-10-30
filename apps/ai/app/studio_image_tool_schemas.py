"""Mirror of contracts/studio-image-tools; internal masks cannot fetch URLs."""
import base64
import re
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from .studio_workflow_schemas import ProjectId, ShapeId, Sha256, StudioWorkflowTarget

STUDIO_IMAGE_TOOLS_REVISION = "studio-image-tools-r1"
STUDIO_IMAGE_TOOL_MASK_MAX_BYTES = 1024 * 1024
STUDIO_IMAGE_TOOL_MAX_PIXELS = 16_777_216
_MAX_LENGTH = ((STUDIO_IMAGE_TOOL_MASK_MAX_BYTES + 2) // 3) * 4 + 64

class StudioImageToolSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["remove-background", "inpaint"]
    mask: str | None = Field(default=None, max_length=_MAX_LENGTH)

    @field_validator("mask", mode="before")
    @classmethod
    def canonical_mask(cls, value):
        if value is None:
            raise ValueError("mask must be absent, never null")
        if not isinstance(value, str) or len(value) > _MAX_LENGTH:
            raise ValueError("Invalid mask")
        match = re.fullmatch(r"data:image/png;base64,([A-Za-z0-9+/]+={0,2})", value)
        if not match or len(match[1]) % 4:
            raise ValueError("A canonical PNG mask is required")
        body = base64.b64decode(match[1], validate=True)
        if not body or len(body) > STUDIO_IMAGE_TOOL_MASK_MAX_BYTES or base64.b64encode(body).decode() != match[1]:
            raise ValueError("Invalid or oversized mask")
        return value

    @model_validator(mode="after")
    def mask_only_for_inpaint(self):
        if (self.operation == "inpaint") != (self.mask is not None):
            raise ValueError("Only inpainting requires a mask")
        return self


class StudioImageToolInput(StudioImageToolSpec):
    """Browser intake mirror; decomposition lineage is never a provider spec."""
    projectId: ProjectId
    mutationId: str = Field(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z")
    documentRevision: int = Field(strict=True, ge=0, le=2147483646)
    workflowRevision: int = Field(strict=True, ge=0, le=2147483646)
    target: StudioWorkflowTarget
    instruction: str | None = Field(default=None, min_length=1, max_length=4000)
    decompositionRequestId: ProjectId | None = None

    @field_validator("instruction", "decompositionRequestId", mode="before")
    @classmethod
    def absent_never_null(cls, value):
        if value is None:
            raise ValueError("optional fields must be absent, never null")
        return value

    @field_validator("instruction", mode="before")
    @classmethod
    def trimmed_instruction(cls, value):
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def inpaint_continuation(self):
        if self.decompositionRequestId is not None and self.operation != "inpaint":
            raise ValueError("Only inpainting may continue a decomposition")
        return self


class StudioLayerRepairContext(BaseModel):
    """Mirror of server-verified provenance. This is not sent to the model."""
    model_config = ConfigDict(extra="forbid", strict=True)
    decompositionRequestId: ProjectId
    sourceShapeId: ShapeId
    assetId: ProjectId
    assetSha256: Sha256
    width: int = Field(gt=0, le=16384)
    height: int = Field(gt=0, le=16384)
    mode: Literal["inferred-completion"]
    independentQuality: Literal["NOT_REVIEWED"]

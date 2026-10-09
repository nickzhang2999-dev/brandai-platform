"""Mirror of packages/contracts/src/studio-workflow.ts; no provider calls."""
from typing import Annotated, Literal
from pydantic import BaseModel, Field, model_validator

ShapeId = Annotated[str, Field(min_length=7, max_length=200, pattern=r"^shape:[\x21-\x7e]+\z")]
Sha256 = Annotated[str, Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]{64}\z")]
ProjectId = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+\z")]

class StrictModel(BaseModel):
    model_config = {"extra": "forbid", "strict": True}

class StudioWorkflowTarget(StrictModel):
    shapeId: ShapeId
    assetSha256: Sha256

class StudioWorkflowReference(StrictModel):
    shapeId: ShapeId | None
    assetSha256: Sha256
    purpose: Literal["EXACT", "ADAPTIVE", "REFERENCE"] | None
    participates: bool

    @model_validator(mode="after")
    def valid_purpose(self):
        if self.participates and self.purpose is None:
            raise ValueError("participating references need a purpose")
        return self

class StudioWorkflowSaveInput(StrictModel):
    projectId: ProjectId
    revision: int = Field(ge=0, le=2147483646)
    mode: Literal["generate", "modify"]
    target: StudioWorkflowTarget | None
    references: list[StudioWorkflowReference] = Field(max_length=8)

    @model_validator(mode="after")
    def valid_selection(self):
        if (self.mode == "modify") != (self.target is not None):
            raise ValueError("mode and target must agree")
        pairs = [(ref.shapeId, ref.assetSha256) for ref in self.references]
        if len(set(pairs)) != len(pairs):
            raise ValueError("duplicate reference")
        return self

class StudioWorkflowIssue(StrictModel):
    code: str
    scope: Literal["asset", "reference", "target"]
    shapeId: ShapeId | None
    assetSha256: Sha256 | None
    message: str
    blocking: bool
    index: int | None = Field(default=None, ge=0, le=7)

    @model_validator(mode="before")
    @classmethod
    def optional_index_not_null(cls, value):
        if isinstance(value, dict) and "index" in value and value["index"] is None:
            raise ValueError("index cannot be null")
        return value

class StudioWorkflowView(StudioWorkflowSaveInput):
    revision: int = Field(ge=0, le=2147483647)
    updatedAt: int | None = Field(ge=0, le=9007199254740991)
    issues: list[StudioWorkflowIssue]

class StudioWorkflowAsset(StrictModel):
    shapeId: ShapeId
    assetSha256: Sha256
    name: str = Field(max_length=255)
    width: float | None = Field(gt=0, allow_inf_nan=False)
    height: float | None = Field(gt=0, allow_inf_nan=False)
    valid: bool
    mime: str

class StudioWorkflowAssets(StrictModel):
    projectId: ProjectId
    assets: list[StudioWorkflowAsset]
    issues: list[StudioWorkflowIssue]

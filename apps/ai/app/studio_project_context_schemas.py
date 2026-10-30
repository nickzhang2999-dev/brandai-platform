"""Confirmed project-context wire mirror. Roles never grant asset permissions."""
from typing import Literal
from datetime import datetime
import re
from pydantic import Field, field_validator, model_validator
from .studio_workflow_schemas import StrictModel, ProjectId, Sha256, ShapeId
from .studio_generation_schemas import MutationId

class StudioProjectContextFacts(StrictModel):
    goal: str = Field(max_length=1000)
    audience: str = Field(max_length=1000)
    approvedCopy: str = Field(max_length=4000)
    visualRequirements: str = Field(max_length=2000)

    @field_validator("goal", "audience", "approvedCopy", "visualRequirements", mode="before")
    @classmethod
    def trimmed(cls, value):
        return value.strip() if isinstance(value, str) else value

MaterialRole = Literal["PRODUCT", "BRAND", "COPY", "STYLE"]

class StudioProjectContextSource(StrictModel):
    assetId: ProjectId
    assetSha256: Sha256

class StudioProjectContextRoleInput(StudioProjectContextSource):
    role: MaterialRole

class StudioProjectContextMasterInput(StudioProjectContextSource):
    shapeId: ShapeId | None = None
    versionId: ProjectId | None = None

    @model_validator(mode="before")
    @classmethod
    def optional_not_null(cls, value):
        if isinstance(value, dict) and any(k in value and value[k] is None for k in ("shapeId", "versionId")):
            raise ValueError("optional source fields must be omitted")
        return value

class StudioProjectContextSaveInput(StrictModel):
    mutationId: MutationId
    expectedRevision: int = Field(ge=0, le=2147483646)
    facts: StudioProjectContextFacts
    materials: list[StudioProjectContextRoleInput] = Field(max_length=7)
    master: StudioProjectContextMasterInput | None
    documentRevision: int | None = Field(default=None, ge=0, le=2147483646)

    @model_validator(mode="before")
    @classmethod
    def revision_omitted(cls, value):
        if isinstance(value, dict) and "documentRevision" in value and value["documentRevision"] is None:
            raise ValueError("optional revision must be omitted")
        return value

    @model_validator(mode="after")
    def valid_sources(self):
        if len({item.assetId for item in self.materials}) != len(self.materials):
            raise ValueError("one explicit responsibility per asset")
        if self.master and self.master.shapeId and self.documentRevision is None:
            raise ValueError("selected master requires saved canvas revision")
        return self

class StudioProjectContextMaterial(StudioProjectContextRoleInput):
    name: str = Field(min_length=1, max_length=255)
    width: int = Field(gt=0, le=16384)
    height: int = Field(gt=0, le=16384)
    versionId: ProjectId | None

class StudioProjectContextMaster(StudioProjectContextSource):
    name: str = Field(min_length=1, max_length=255)
    width: int = Field(gt=0, le=16384)
    height: int = Field(gt=0, le=16384)
    versionId: ProjectId | None
    shapeId: ShapeId | None

class StudioProjectContextSnapshot(StrictModel):
    projectId: ProjectId
    revision: int = Field(ge=0, le=2147483646)
    facts: StudioProjectContextFacts
    materials: list[StudioProjectContextMaterial] = Field(max_length=7)
    master: StudioProjectContextMaster | None
    updatedAt: str | None

    @field_validator("updatedAt")
    @classmethod
    def valid_time(cls, value):
        if value is not None:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z", value):
                raise ValueError("UTC ISO datetime required")
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value

    @model_validator(mode="after")
    def unique_materials(self):
        if len({item.assetId for item in self.materials}) != len(self.materials):
            raise ValueError("duplicate material responsibilities")
        return self

class StudioProjectContextIssue(StrictModel):
    scope: Literal["material", "master"]
    assetId: ProjectId
    code: Literal["SOURCE_UNAVAILABLE", "SOURCE_CHANGED"]
    message: str = Field(min_length=1, max_length=500)

class StudioProjectContextView(StudioProjectContextSnapshot):
    issues: list[StudioProjectContextIssue] = Field(max_length=8)

class StudioConversationProjectMaterial(StrictModel):
    name: str = Field(min_length=1, max_length=255)
    role: MaterialRole
    referenceId: str | None = Field(min_length=1, max_length=200)

class StudioConversationProjectContext(StrictModel):
    revision: int = Field(ge=0, le=2147483646)
    facts: StudioProjectContextFacts
    materials: list[StudioConversationProjectMaterial] = Field(max_length=7)
    masterReferenceId: str | None = Field(min_length=1, max_length=200)

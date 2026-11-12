"""Wire mirror for packages/contracts/src/deepflare-v2.ts. No AI route/provider."""
from typing import Annotated, Literal
from pydantic import Field, model_validator
from .studio_workflow_schemas import StrictModel, ProjectId
from .studio_generation_schemas import MutationId

Revision = Annotated[int, Field(ge=1, le=2147483646)]
MemoryKind = Literal["INSPIRATION", "COPY", "VISUAL", "FEEDBACK"]

class DeepFlareV2Scope(StrictModel):
    workspaceId: ProjectId
    projectId: ProjectId

class DeepFlareV2InspirationRef(StrictModel):
    source: Literal["ommi"]
    caseId: ProjectId
    sourceVersion: str = Field(min_length=1, max_length=128)
    insightIds: list[ProjectId] = Field(min_length=1, max_length=8)
    application: str = Field(min_length=1, max_length=1000)

class DeepFlareV2Deliverable(StrictModel):
    id: ProjectId
    channel: str = Field(min_length=1, max_length=100)
    width: int = Field(ge=32, le=8192)
    height: int = Field(ge=32, le=8192)

class DeepFlareV2Brief(StrictModel):
    text: str = Field(min_length=1, max_length=8000)
    mode: Literal["DIRECTION_FIRST", "DIRECT"]
    deliverables: list[DeepFlareV2Deliverable] = Field(min_length=1, max_length=6)
    inspiration: list[DeepFlareV2InspirationRef] = Field(max_length=8)

    @model_validator(mode="after")
    def distinct_deliverables(self):
        if len({d.id for d in self.deliverables}) != len(self.deliverables):
            raise ValueError("duplicate deliverable")
        return self

class DeepFlareV2Direction(StrictModel):
    summary: str = Field(min_length=1, max_length=1000)
    composition: str = Field(min_length=1, max_length=3000)

class DeepFlareV2CreateInput(StrictModel):
    mutationId: MutationId
    brief: DeepFlareV2Brief

class SetDirection(StrictModel):
    type: Literal["SET_DIRECTION"]
    direction: DeepFlareV2Direction

class ReviseBrief(StrictModel):
    type: Literal["REVISE_BRIEF"]
    brief: DeepFlareV2Brief

class Submit(StrictModel):
    type: Literal["SUBMIT"]

class ConfirmDirection(StrictModel):
    type: Literal["CONFIRM_DIRECTION"]
    planVersion: Revision

class RequestRevision(StrictModel):
    type: Literal["REQUEST_REVISION"]
    reason: str = Field(min_length=1, max_length=2000)

class Cancel(StrictModel):
    type: Literal["CANCEL"]

DeepFlareV2Command = Annotated[
    SetDirection | ReviseBrief | Submit | ConfirmDirection | RequestRevision | Cancel,
    Field(discriminator="type"),
]

class DeepFlareV2CommandInput(StrictModel):
    mutationId: MutationId
    expectedRevision: Revision
    command: DeepFlareV2Command

class DeepFlareV2Task(StrictModel):
    id: ProjectId
    role: Literal["INSPIRATION", "COPYWRITING", "VISUAL", "ADAPTATION", "QA"]
    dependsOn: list[ProjectId] = Field(max_length=12)
    memoryKinds: list[MemoryKind] = Field(max_length=4)
    deliverableId: ProjectId | None

class DeepFlareV2State(StrictModel):
    protocolVersion: Literal[1]
    revision: Revision
    planVersion: Revision
    status: Literal["DRAFT", "AWAITING_DIRECTION", "REVISION_REQUESTED", "READY", "CANCELLED"]
    brief: DeepFlareV2Brief
    direction: DeepFlareV2Direction | None
    approvedPlanVersion: Revision | None
    revisionReason: str | None = Field(min_length=1, max_length=2000)
    tasks: list[DeepFlareV2Task] = Field(min_length=4, max_length=9)

class DeepFlareV2Receipt(DeepFlareV2Scope):
    id: ProjectId
    state: DeepFlareV2State
    executionAvailable: Literal[False]

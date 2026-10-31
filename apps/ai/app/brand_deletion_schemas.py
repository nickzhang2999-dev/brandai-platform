"""Mirror of packages/contracts/src/brand-deletion.ts (BFF-only contracts)."""
import re
from typing import Annotated, Literal
from pydantic import BaseModel, Field, field_validator, model_validator

Identity = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")]
Count = Annotated[int, Field(strict=True, ge=0)]


class StrictModel(BaseModel):
    model_config = {"extra": "forbid", "strict": True}


class BrandDeletionCounts(StrictModel):
    projects: Count
    assets: Count
    rules: Count
    terms: Count
    prohibitions: Count
    inspirationCases: Count
    members: Count


class BrandDeletionPreview(StrictModel):
    workspaceId: Identity
    name: str = Field(min_length=1, max_length=80)
    counts: BrandDeletionCounts
    activeTasks: Count
    canDelete: bool
    blockedReason: str | None = Field(min_length=1, max_length=300)
    confirmationToken: str = Field(pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def readiness(self):
        if self.canDelete != (self.activeTasks == 0) or self.canDelete != (self.blockedReason is None):
            raise ValueError("Invalid deletion readiness")
        return self


class BrandDeletionInput(StrictModel):
    confirmationName: str = Field(min_length=1, max_length=80)
    confirmationToken: str = Field(pattern=r"^[a-f0-9]{64}$")
    mutationId: str

    @field_validator("mutationId")
    @classmethod
    def valid_uuid(cls, value):
        if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", value):
            raise ValueError("Invalid mutation id")
        return value


class BrandDeletionResult(StrictModel):
    ok: Literal[True]
    deletedWorkspaceId: Identity
    nextWorkspaceId: Identity | None
    redirectTo: str

    @field_validator("ok", mode="before")
    @classmethod
    def literal_true(cls, value):
        if value is not True:
            raise ValueError("Expected true")
        return value

    @model_validator(mode="after")
    def local_destination(self):
        expected = f"/studio?workspaceId={self.nextWorkspaceId}#/home" if self.nextWorkspaceId else "/studio"
        if self.redirectTo != expected:
            raise ValueError("Invalid deletion destination")
        return self

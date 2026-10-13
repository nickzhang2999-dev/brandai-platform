"""Web-only Studio import protocol mirror; importing these types never calls AI."""
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, Field, field_validator


class StudioBrandDraftImportInput(BaseModel):
    model_config = {"extra": "forbid"}
    mutationId: str = Field(strict=True)
    expectedDraftRevision: int = Field(strict=True, ge=1, le=2147483646)

    @field_validator("mutationId")
    @classmethod
    def uuid_string(cls, value: str) -> str:
        parsed = UUID(value)
        if str(parsed) != value.lower():
            raise ValueError("mutationId must use UUID text format")
        return value


class StudioBrandDraftImportState(BaseModel):
    model_config = {"extra": "forbid"}
    available: bool = Field(strict=True)
    draftRevision: int = Field(strict=True, ge=0, le=2147483646)
    importableTypes: list[Literal["color", "font"]] = Field(max_length=2)
    hasNotes: bool = Field(strict=True)


class StudioBrandDraftImportResult(BaseModel):
    model_config = {"extra": "forbid"}
    mutationId: str = Field(strict=True)
    draftRevision: int = Field(strict=True, ge=1, le=2147483646)
    ruleIds: list[str] = Field(min_length=2, max_length=2)
    created: Literal[2]
    replayed: bool = Field(strict=True)
    notesPreserved: bool = Field(strict=True)

    _uuid_string = field_validator("mutationId")(StudioBrandDraftImportInput.uuid_string.__func__)

    @field_validator("ruleIds")
    @classmethod
    def nonempty_ids(cls, value: list[str]) -> list[str]:
        if not all(value):
            raise ValueError("rule IDs cannot be empty")
        return value
